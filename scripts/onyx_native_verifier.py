"""Live native identity/TLS/storage verification for one leased Onyx recipe.

The helper chooses the immutable recipe directory. The caller cannot provide a
command, hostname, identity, proof flag, or credential. All probes return only
bounded metadata; credential reads stay inside their owning containers.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sqlite3
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from module_deployment_helper import DeploymentError, private_json, run


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = _module("ava_native_storage_verifier", "verify-onyx-live-storage.py")
entry = _module("ava_native_entry_verifier", "verify-onyx-customer-entry.py")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def require(condition, code="DEPLOYMENT_NATIVE_PROOF_INCOMPLETE"):
    if not condition:
        raise DeploymentError(code)


def load_operator(root, scope, database):
    _, operator = private_json(root / "config/native-verifier.json")
    require(set(operator) == {"schemaVersion", "kind", "businessId", "deploymentId", "nativeScope", "revision", "principal", "foreignScope"},
            "DEPLOYMENT_NATIVE_VERIFIER_CONFIGURATION_REQUIRED")
    manifest = {key: value for key, value in operator.items() if key != "foreignScope"}
    exact = {"businessId": scope["businessId"], "deploymentId": scope["deploymentId"], "nativeScope": scope["namespace"], "revision": scope["revision"]}
    require(all(manifest.get(key) == value for key, value in exact.items()))
    require(manifest.get("schemaVersion") == 1 and manifest.get("kind") == "ava_onyx_customer_entry_operator")
    principal = manifest.get("principal")
    require(isinstance(principal, dict) and set(principal) == {"userId", "subject", "role"})
    entry._uuid(principal.get("userId"))
    require(principal.get("role") == "hotel_owner" and isinstance(principal.get("subject"), str))
    # A root manifest is an installation input, not authority to invent an
    # owner. Reconcile it with the current enabled CRM membership and subject.
    with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as db:
        owner = db.execute("SELECT 1 FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id "
            "JOIN instances i ON i.id=m.businessId WHERE u.id=? AND u.subject=? AND u.enabled=1 AND m.enabled=1 "
            "AND m.businessId=? AND m.role='hotel_owner' AND i.isActive=1",
            (principal["userId"], principal["subject"], scope["businessId"])).fetchone()
        require(owner is not None)
    foreign = storage._scope(operator["foreignScope"])
    require(foreign["businessId"] != exact["businessId"] and foreign["deploymentId"] != exact["deploymentId"]
            and foreign["nativeScope"] != exact["nativeScope"])
    return manifest, exact, foreign


def tls_probe(hostname):
    # System CA verification and hostname validation stay enabled. No redirect
    # is accepted, so an unrelated ingress cannot stand in for this hostname.
    with build_opener(ProxyHandler({}), NoRedirect()).open("https://" + hostname + "/healthz", timeout=10) as response:
        return response.status == 200 and len(response.read(16385)) <= 16384


def entry_probe(container, manifest, scope):
    # Run the existing exact native peer checks, passing reviewed code and
    # metadata over stdin. Never print the session cookie or peer credential.
    source = Path(entry.__file__).read_text()
    wrapper = "import types,json\nm=types.ModuleType('ava_entry');exec(compile(" + repr(source) + ",'<ava-entry>','exec'),m.__dict__)\n"
    wrapper += "manifest=json.loads(" + repr(json.dumps(manifest)) + ");scope=json.loads(" + repr(json.dumps(scope)) + ")\n"
    wrapper += "assert m.runtime_scope()==scope\nm.read_operator_manifest=lambda path,current:manifest\nprint(json.dumps(m.run(m.Path('/trusted-in-memory'))))\n"
    # The normal helper runner accepts no stdin, so use storage's bounded
    # credential-safe subprocess boundary, which explicitly captures stderr.
    output = storage._run(["docker", "exec", "-i", container, "python", "-B", "-"], input_data=wrapper, limit=32768)
    value = json.loads(output.strip().splitlines()[-1])
    return entry.validate_receipt(value, scope, manifest["principal"]["userId"])


def container_for(scope, service, image):
    ids = run(["docker", "ps", "-aq", "--no-trunc", "--filter", "label=tech.melud.ava.deployment=" + scope["deploymentId"],
               "--filter", "label=com.docker.compose.service=" + service], timeout=15).split()
    require(len(ids) == 1 and re.fullmatch(r"[0-9a-f]{64}", ids[0]))
    output = run(["docker", "inspect", "--format", storage.DOCKER_FORMAT, ids[0]], timeout=15)
    row = json.loads(output)
    expected = {"id": ids[0], "deployment": scope["deploymentId"], "business": str(scope["businessId"]),
                "revision": str(scope["revision"]), "project": scope["nativeScope"], "service": service, "image": image,
                "image_id": image.split("@")[-1], "running": True, "health": "healthy"}
    require(all(row.get(key) == value for key, value in expected.items()))
    return ids[0]


class OnyxNativeVerifier:
    def __init__(self, recipes, database):
        self.recipes, self.database = Path(recipes), Path(database)

    def __call__(self, identity, recipe):
        require(identity.get("module") == "onyx", "DEPLOYMENT_NATIVE_VERIFIER_REQUIRED")
        root = self.recipes / identity["deploymentId"]
        try:
            manifest, scope, foreign = load_operator(root, identity, self.database)
            _, compose = private_json(root / "compose.json")
            _, keys = private_json(root / "secrets.json")
            # Administration credentials must be absent from every runtime
            # process's prepared environment and mounts. The storage probes
            # independently verify the actual runtime ACL, not this text alone.
            env_path = root / "config/native.env"
            from module_deployment_helper import owned_path
            owned_path(env_path)
            env_text = env_path.read_text()
            require(all(keys[name] not in env_text for name in ("dbAdmin", "blobRootAccess", "blobRootSecret")))
            require("POSTGRES_USER=" + scope["nativeScope"] + "\n" in env_text)
            require(tls_probe(identity["hostname"]))
            api = container_for(scope, "api", compose["services"]["api"]["image"])
            auth = container_for(scope, "auth", compose["services"]["auth"]["image"])
            entry_probe(auth, manifest, scope)
            storage.probe(api, scope, foreign)
            # This is infrastructure admission only. Source retrieval and the
            # runtime machine principal remain separate, subsequent gates.
            return {**identity, "imageDigest": recipe["imageDigest"], "tlsVerified": True,
                    "nativeIdentityVerified": True, "storageIsolationVerified": True, "foreignAccessDenied": True,
                    "bootstrapExcludedFromRuntime": True, "secretReference": f"module/{identity['deploymentId']}/runtime/v{identity['revision']}"}
        except DeploymentError:
            raise
        except (OSError, ValueError, KeyError, sqlite3.Error, entry.VerificationError, storage.VerificationError):
            raise DeploymentError("DEPLOYMENT_NATIVE_PROOF_INCOMPLETE") from None
