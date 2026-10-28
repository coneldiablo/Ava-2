# Generic isolated native knowledge release gates

These commands apply to any active business, including business 4. No business,
deployment UUID, source ID, hostname, port, owner identity or provider credential
is hardcoded into the workflow. No command below was run against production as
part of this patch. Run the plan before an explicitly coordinated release.

1. The provisioning worker uses `AVA_KNOWLEDGE_PROVISIONING_ENABLED=true`,
   `AVA_PROVISIONING_JOBS_ENABLED=false`, `AVA_ISOLATED_MODULES_ENABLED=true`,
   `AVA_MODULE_DEPLOYMENT_SOCKET`. Only `knowledge_base` and `onyx_runtime` jobs
   are eligible. Do not unblock SIP, CRM workspace or WhatsApp jobs here.
2. Install the reviewed helper as root with a root-owned recipe directory,
   CRM database path, worker Unix UID, digest catalogue and the option
   `--enable-onyx-native-verifier`. The optional `knowledgeOverlayManifest`
   catalogue field must contain schemaVersion 1, the pinned sourceCommit,
   exact backendImageDigest and exact hashes of `KNOWLEDGE_OVERLAY_FILES`.
   The coordinator's read-only baseline for business 1 API/auth/knowledge-api
   is `ava-onyx-knowledge-api@sha256:ac9c0d123dc1723a2f1a5151900ffdf52114322c5b8e4a5a7f4237b4887d884a`,
   upstream `a1b9e02eb65cc114c65381cbef5e555e1753ed0a`. The six recovered
   sources are unchanged. This is a final backend candidate only after the
   coordinator audits actual image source hashes/labels and approves reuse;
   this patch has not built or accepted a new image. It is already patched
   and cannot be used as `ONYX_AUTH_IMAGE` for `Dockerfile.knowledge` because
   both checksum installers deliberately reject patched source. For a new
   image, build that Dockerfile from the reviewed pre-knowledge pinned
   auth/http/namespace/tokenizer parent. Record its actual returned digest
   in both the catalogue backendImage and knowledgeOverlayManifest, never an
   invented digest. The new contour reserves 13824 MiB;
   existing catalogues remain at 12800 MiB. Existing prepared recipes are not
   overwritten. Capacity and TLS can block provisioning legitimately.
3. Root installs `<recipes>/<deployment>/config/native-verifier.json`, with
   `schemaVersion:1`, `kind:ava_onyx_customer_entry_operator`, businessId,
   deploymentId, nativeScope, revision, principal `{userId,subject,role}` and
   foreignScope `{businessId,deploymentId,nativeScope,revision}`. The principal
   must be the current enabled CRM hotel owner. Foreign scope must be different
   and operator-selected. The helper performs fresh TLS, native session and
   storage ACL checks. It does not accept receipt booleans as live proof.
4. Native infrastructure must become `verified`. New businesses have no
   integration anchor. Set `AVA_PROCESS_ROLE=provisioning-worker`,
   `AVA_ONYX_BOOTSTRAP_CONFIG` and `AVA_CRM_DB_PATH`, then run the generic plan
   and explicit preparation in the reviewed worker release environment:

```sh
node scripts/prepare-onyx-native-integration.cjs
node scripts/prepare-onyx-native-integration.cjs --run
```

   This inserts only a new `STAGING` namespace anchor with no API credential,
   CC pair or legacy agent binding. It activates an isolated adapter using the
   prepared deployment ID and peer hash. An existing legacy link/full adapter,
   disabled owner, foreign enrollment or changed revision fails closed. Existing
   integrations require their separately approved migration; this script cannot
   overwrite them. Bootstrap is a separate gate. Set
   `AVA_ONYX_BOOTSTRAP_CONFIG`, `AVA_CRM_DB_PATH`, `AVA_ONYX_RECIPES_DIRECTORY`.
   The root-owned 0600 bootstrap JSON has exactly businessId, deploymentId,
   nativeScope, revision, ownerUserId, modelConfigurationId, providerId,
   providerApiBase and modelName. Use existing approved Onyx IDs and model;
   `providerApiBase` is the approved HTTPS AVA `/api/integrations/onyx/llm`
   endpoint and `modelName` is exactly `ava-hotel-<business>`. The existing native
   provider credential must hash to the current enabled
   `onyx_llm_deployment_credentials` row for this exact deployment and revision.
   A direct AITunnel key, legacy business token or another tenant's token is
   refused. The AVA gateway retains the approved upstream AITunnel/model choice.
   Model validation creates nothing and prints no provider key or source text.
   An absent own-deployment token/provider/model is an explicit prerequisite:
   prepare it through the approved worker-only
   `OnyxLlmGateway.issueDeploymentToken({businessId,deploymentId,expectedRevision})`
   path and private native provider setup. Never reuse another organization's
   provider row or key. The generic bootstrap cannot manufacture this gate.

```sh
python3 scripts/bootstrap-onyx-native-knowledge.py
python3 scripts/bootstrap-onyx-native-knowledge.py --run
```

The first command reads canonical parsed chunks and deployment state, with no
native request or credential read. The second performs idempotent owner/runtime
native provisioning, private bootstrap, source catch-up and actual guarded
runtime document retrieval and actual live default-index retrieval. The latter
loads the exact private persona/document set/SearchTool, active runtime user,
runtime ACL and tenant context, then uses v4.7 `random_retrieval` with a single
source tag and verifies every returned document ID/business/source/current hash.
Empty, foreign, hidden, malformed or stale results block admission. A foreign
business index filter must return no documents. No source text or query leaves
the process or appears in its receipt. This proves indexed source availability;
semantic answer quality remains customer acceptance. It does not call an LLM.
Source hashes, revocation
and revisions are rechecked before publishing the projection. Successful
ingestion ACK alone keeps `searchabilityVerified=false`. The readback proof is
metadata only, with no source text or credential, and runtime admission remains
false until the worker admits it.

5. In the reviewed provisioning-worker release environment, set
   `AVA_PROCESS_ROLE=provisioning-worker`, `AVA_CRM_DB_PATH` and
   `AVA_ONYX_RUNTIME_READBACK_FILE` to the root-only `knowledge-runtime-readback.json`.
   Use a fresh proof within 60 seconds. The proof carries the initial adapter ID,
   adapter revision, integration ID/revision, peer hash and deployment revision
   observed before native probing; bootstrap rereads them afterwards. This command calls the existing
   `OnyxRuntimeAccess.admit` with exact current adapter, principal, deployment,
   integration and current-source fences:

```sh
node scripts/admit-onyx-native-knowledge.cjs --run
```

6. The private gateway machine listener 4081 and trusted
   `AVA_ONYX_NATIVE_RUNTIME_DIRECTORY/<business>.json` are a separate release
   gate. Use a distinct runtime peer secret and native API origin, no public
   proxy route. Mount the root-owned directory read-only; files are 0440,
   root:1000, max 4096 bytes, exact business/deployment/revision. Keep the
   runtime disabled until admission succeeds. Existing legacy links remain
   untouched by source projection. Read back the real customer flow separately.
   Before launching the new runtime image, audit its actual mount and env.
   Current production's old `/run/ava-onyx-runtime` directory contains the enabled
   pilot `1.json` in the old shape. The coordinator must mount a NEW root-owned
   runtime directory containing ONLY the admitted new business's config (for
   this release, `4.json`). Leave the old directory and business 1 untouched.
   Point `AVA_ONYX_NATIVE_RUNTIME_DIRECTORY` at the new read-only mount. With no
   `1.json` there, business 1 retains its existing legacy path. Do not copy/import
   the old pilot file or weaken configured-invalid fail-closed behavior.

For automatic edits/deletes, use the generic periodic CLI and the per-deployment
systemd templates in this directory. Set `AVA_ONYX_CODE_DIRECTORY` to the immutable
reviewed release, `AVA_ONYX_RECIPES_DIRECTORY`, `AVA_ONYX_DEPLOYMENT_ID` and
`AVA_CRM_DB_PATH`. Bootstrap must first have created this deployment's private
reconcile config/key/bootstrap receipt. The periodic job needs no model/provider
creation, supports an empty corpus, and sends only fixed upsert/delete operations
through `docker exec` inside the exact labelled, healthy, digest-fenced private
knowledge container. The private API is never published on the host. It probes
the current index through the exact own API container before projection; ACK
with an old index hash leaves the old projection intact and retries next tick.
Removing the last source requires an empty live own index before empty projection.

```sh
python3 "$AVA_ONYX_CODE_DIRECTORY/scripts/sync-onyx-native-knowledge.py"
python3 "$AVA_ONYX_CODE_DIRECTORY/scripts/sync-onyx-native-knowledge.py" --run
```

The coordinator installs `/etc/ava/onyx-native-knowledge/<deployment>.env` as
root:root 0600 from `native-knowledge-sync.env.example`, installs the two unit
templates, and supplies a root-owned per-deployment service drop-in. The verified
production SQLite parent is `/root/ava-releases/single-host-20260907T100000Z/data/whatsapp_crm`.
Use this same durable directory (including WAL/shm files), not a database copy:

```ini
[Service]
BindPaths=/root/ava-releases/single-host-20260907T100000Z/data/whatsapp_crm:/run/ava-crm
```

Set `AVA_CRM_DB_PATH=/run/ava-crm/<actual database basename>` in the service env.
The templates use `ProtectHome=true`; the reviewed bind exposes only this DB
directory. `ReadWritePaths` must match the actual root-owned recipe parent and
`/run/ava-crm`. Install the immutable code outside `/root`, such as the reviewed
`/opt/ava-build/<release>`, and leave all unrelated business timers unchanged.
The following are explicit coordinator release actions, not actions performed
by this patch:

```sh
install -d -o root -g root -m 0700 /etc/ava/onyx-native-knowledge
install -o root -g root -m 0644 "$AVA_ONYX_CODE_DIRECTORY/deploy/onyx/ava-native-knowledge-sync@.service" /etc/systemd/system/
install -o root -g root -m 0644 "$AVA_ONYX_CODE_DIRECTORY/deploy/onyx/ava-native-knowledge-sync@.timer" /etc/systemd/system/
# Install the reviewed 0600 per-deployment env and BindPaths drop-in first.
systemd-analyze verify /etc/systemd/system/ava-native-knowledge-sync@.service /etc/systemd/system/ava-native-knowledge-sync@.timer
systemctl daemon-reload
systemctl enable --now "ava-native-knowledge-sync@$AVA_ONYX_DEPLOYMENT_ID.timer"
systemctl status "ava-native-knowledge-sync@$AVA_ONYX_DEPLOYMENT_ID.timer" --no-pager
```

Stop only this deployment's timer during rollback before revoking its adapter.
For a dedicated private endpoint, the reconciler also accepts
`AVA_ONYX_RECONCILE_CONFIG`, `AVA_ONYX_RECONCILE_CHECKPOINT`,
`AVA_CRM_DB_PATH`, `AVA_ONYX_KNOWLEDGE_URL`, `AVA_AUTH_WORKER_KEY_FILE`.
The endpoint must be loopback/private, redirect-free and deployment-scoped;
the standard new recipe exposes no public or host port. The native container
mounts `/run/ava-keys/worker.key` read-only and the auth state read-only at
`/var/lib/ava-auth`; it has no Docker socket. The periodic reconciler must run
with those fences and project only a matching current checkpoint.

```sh
python3 scripts/reconcile-onyx-native-knowledge.py --dry-run
python3 scripts/project-onyx-native-knowledge.py
python3 scripts/project-onyx-native-knowledge.py --run
python3 scripts/project-onyx-native-knowledge.py --rollback
python3 scripts/project-onyx-native-knowledge.py --rollback --run
```

Projection additionally uses `AVA_ONYX_KNOWLEDGE_BOOTSTRAP_RECEIPT`. `--run`
requires `AVA_ONYX_INDEX_READBACK_FILE` pointing to this deployment's root-only
`knowledge-index-readback.json`, produced by bootstrap/periodic live index probe
within 60 seconds, with exact scope and current source hashes. Missing/old/index
mismatched proof fails closed; standalone ACK projection cannot bypass readiness.
Rollback removes only matching deployment/business/revision native projection
rows; it preserves documents, volumes, legacy tables and other businesses.
Disable the admitted runtime/adapter through the existing worker revocation
path before releasing the old runtime config. Restore the previous root
configuration/image from the coordinated release backup; do not remove volumes.

Fixture tests prove contracts only. Native image build, TLS/DNS, worker socket,
approved model credentials, native storage/retrieval, and customer/browser
acceptance are production release gates and must be recorded separately.
