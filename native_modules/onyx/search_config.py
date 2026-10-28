"""Create durable private TLS and Community OpenSearch security configuration."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import tempfile
from typing import Callable


NAMESPACE = re.compile(r"ava_[0-9a-f]{32}\Z")
SAFE_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/var/empty"}
TLS_FILES = ("ca.pem", "ca-key.pem", "node.pem", "node-key.pem", "admin.pem", "admin-key.pem")


class SearchConfigError(RuntimeError):
    pass


Runner = Callable[[list[str]], None]


def _runner(command: list[str]) -> None:
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=30, env=SAFE_ENV)
    except (OSError, subprocess.SubprocessError) as exc:
        raise SearchConfigError("SEARCH_TLS_GENERATION_FAILED") from exc


def _write(path: Path, content: str, mode: int, owner: tuple[int, int]) -> None:
    path.write_text(content, encoding="utf-8")
    os.chmod(path, mode)
    os.chown(path, *owner)


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verify_certificates(root: Path, run: Runner) -> None:
    run(["openssl", "verify", "-CAfile", str(root / "ca.pem"), "-purpose", "sslserver", str(root / "node.pem")])
    run(["openssl", "verify", "-CAfile", str(root / "ca.pem"), "-purpose", "sslclient", str(root / "admin.pem")])
    try:
        decoded = ssl._ssl._test_decode_cert(str(root / "node.pem"))
    except (OSError, ValueError, ssl.SSLError) as exc:
        raise SearchConfigError("SEARCH_TLS_GENERATION_FAILED") from exc
    if ("DNS", "search") not in decoded.get("subjectAltName", ()):
        raise SearchConfigError("SEARCH_TLS_GENERATION_FAILED")


def _config_files(namespace: str) -> dict[str, str]:
    # RFC2253 order of certificates generated with /CN=.../OU=AVA/O=MeludTech.
    # OpenSearch compares this canonical name, not the openssl -subj order.
    admin_dn = f"O=MeludTech,OU=AVA,CN=ava-admin-{namespace.removeprefix('ava_')}"
    node_dn = "O=MeludTech,OU=AVA,CN=search"
    opensearch = f"""cluster.name: {namespace}
node.name: search
network.host: 0.0.0.0
network.publish_host: search
discovery.type: single-node
plugins.security.ssl.transport.pemcert_filepath: ava-tls/node.pem
plugins.security.ssl.transport.pemkey_filepath: ava-tls/node-key.pem
plugins.security.ssl.transport.pemtrustedcas_filepath: ava-tls/ca.pem
plugins.security.ssl.transport.enforce_hostname_verification: true
plugins.security.ssl.transport.resolve_hostname: false
plugins.security.ssl.http.enabled: true
plugins.security.ssl.http.pemcert_filepath: ava-tls/node.pem
plugins.security.ssl.http.pemkey_filepath: ava-tls/node-key.pem
plugins.security.ssl.http.pemtrustedcas_filepath: ava-tls/ca.pem
plugins.security.authcz.admin_dn:
  - '{admin_dn}'
plugins.security.nodes_dn:
  - '{node_dn}'
plugins.security.allow_default_init_securityindex: false
"""
    config = """_meta:
  type: config
  config_version: 2
config:
  dynamic:
    http:
      anonymous_auth_enabled: false
    authc:
      basic_internal_auth_domain:
        description: AVA internal runtime users
        http_enabled: true
        transport_enabled: true
        order: 0
        http_authenticator:
          type: basic
          challenge: true
        authentication_backend:
          type: intern
"""
    empty = lambda kind: f"_meta:\n  type: {kind}\n  config_version: 2\n"
    return {
        "opensearch.yml": opensearch,
        "security/config.yml": config,
        "security/internal_users.yml": empty("internalusers"),
        "security/roles.yml": empty("roles"),
        "security/roles_mapping.yml": empty("rolesmapping"),
        "security/action_groups.yml": empty("actiongroups"),
        "security/tenants.yml": empty("tenants"),
        "security/nodes_dn.yml": empty("nodesdn"),
        "security/allowlist.yml": empty("allowlist"),
    }


def _validate_existing(root: Path, namespace: str, run: Runner, owner: tuple[int, int], search_gid: int) -> dict:
    directory_policy = ((root, owner[1], 0o700), (root / "security", search_gid, 0o750))
    for directory, gid, mode in directory_policy:
        info = directory.lstat()
        if (directory.is_symlink() or not directory.is_dir()
                or info.st_uid != owner[0] or info.st_gid != gid
                or info.st_mode & 0o777 != mode):
            raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
    claim_path = root / "tls-claims.json"
    try:
        claims = json.loads(claim_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT") from exc
    expected_keys = {"schemaVersion", "namespace", "files"}
    if not isinstance(claims, dict) or set(claims) != expected_keys or claims["schemaVersion"] != 1 or claims["namespace"] != namespace:
        raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
    expected_files = {*TLS_FILES, *_config_files(namespace).keys()}
    if not isinstance(claims["files"], dict) or set(claims["files"]) != expected_files:
        raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
    claim_info = claim_path.lstat()
    if (claim_path.is_symlink() or not claim_path.is_file()
            or claim_info.st_uid != owner[0] or claim_info.st_gid != owner[1]
            or claim_info.st_mode & 0o777 != 0o400):
        raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
    for name, digest in claims["files"].items():
        path = root / name
        init_private_key = name in ("node-key.pem", "admin-key.pem")
        mode = 0o440 if init_private_key else (0o400 if "key" in name else 0o444)
        gid = search_gid if init_private_key else owner[1]
        info = path.lstat()
        if (path.is_symlink() or not path.is_file() or info.st_uid != owner[0] or info.st_gid != gid
                or info.st_mode & 0o777 != mode or _hash(path) != digest):
            raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
    _verify_certificates(root, run)
    return claims


def ensure_search_config(config_root: str | Path, namespace: str, search_gid: int, run: Runner = _runner,
                         owner: tuple[int, int] = (0, 0)) -> dict:
    """Create once, then verify exact private files on every replay."""
    if os.geteuid() != 0:
        raise SearchConfigError("SEARCH_CONFIG_ROOT_REQUIRED")
    if not NAMESPACE.fullmatch(namespace) or type(search_gid) is not int or not 1 <= search_gid <= 65535:
        raise SearchConfigError("SEARCH_CONFIG_SCOPE_INVALID")
    config_root = Path(config_root)
    root = config_root / "search-config"
    if root.exists() or root.is_symlink():
        if root.is_symlink() or not root.is_dir():
            raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")
        return _validate_existing(root, namespace, run, owner, search_gid)
    if any(path.name.startswith(".search-config-") for path in config_root.iterdir()):
        raise SearchConfigError("SEARCH_TLS_OWNERSHIP_CONFLICT")

    temporary = Path(tempfile.mkdtemp(prefix=".search-config-", dir=config_root))
    try:
        os.chmod(temporary, 0o700); os.chown(temporary, *owner)
        subject = namespace.removeprefix("ava_")
        run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(temporary / "ca-key.pem")])
        run(["openssl", "req", "-x509", "-new", "-sha256", "-days", "3650", "-key", str(temporary / "ca-key.pem"), "-out", str(temporary / "ca.pem"),
             "-subj", f"/CN=AVA Onyx CA {subject}/OU=AVA/O=MeludTech",
             "-addext", "basicConstraints=critical,CA:TRUE",
             "-addext", "keyUsage=critical,keyCertSign,cRLSign"])
        for name, common_name, purpose in (("node", "search", "serverAuth,clientAuth"), ("admin", "ava-admin-" + subject, "clientAuth")):
            run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(temporary / f"{name}-key.pem")])
            run(["openssl", "req", "-new", "-sha256", "-key", str(temporary / f"{name}-key.pem"), "-out", str(temporary / f"{name}.csr"), "-subj", f"/CN={common_name}/OU=AVA/O=MeludTech"])
            extension = temporary / f"{name}.ext"
            san = "subjectAltName=DNS:search\n" if name == "node" else ""
            _write(extension, "[v3_req]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=" + purpose + "\n" + san, 0o600, owner)
            run(["openssl", "x509", "-req", "-sha256", "-days", "825", "-in", str(temporary / f"{name}.csr"), "-CA", str(temporary / "ca.pem"), "-CAkey", str(temporary / "ca-key.pem"), "-CAcreateserial", "-out", str(temporary / f"{name}.pem"), "-extfile", str(extension), "-extensions", "v3_req"])
            (temporary / f"{name}.csr").unlink(); extension.unlink()
        (temporary / "ca.srl").unlink(missing_ok=True)
        for name in TLS_FILES:
            init_private_key = name in ("node-key.pem", "admin-key.pem")
            mode = 0o440 if init_private_key else (0o400 if "key" in name else 0o444)
            os.chmod(temporary / name, mode)
            os.chown(temporary / name, owner[0], search_gid if init_private_key else owner[1])
        for name, content in _config_files(namespace).items():
            path = temporary / name
            path.parent.mkdir(mode=0o700, exist_ok=True)
            _write(path, content, 0o444, owner)
        # The non-root securityadmin process gets traversal/read access only to
        # its fixed YAML directory.  The parent remains root-only and the CA
        # signing key is neither group-readable nor part of the init mounts.
        os.chown(temporary / "security", owner[0], search_gid)
        os.chmod(temporary / "security", 0o750)
        files = {name: _hash(temporary / name) for name in [*TLS_FILES, *_config_files(namespace).keys()]}
        claims = {"schemaVersion": 1, "namespace": namespace, "files": files}
        _write(temporary / "tls-claims.json", json.dumps(claims, sort_keys=True, separators=(",", ":")) + "\n", 0o400, owner)
        _verify_certificates(temporary, run)
        os.replace(temporary, root)
        return claims
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
