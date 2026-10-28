# Restricted module deployment launcher

Status: implementation and isolated launcher QA, **not an installable complete
Twenty/Onyx provisioning release**. Customer feature flags stay off. No production
helper daemon or module route was installed by this work.

## Trust boundary

`scripts/module_deployment_helper.py` listens only on a Unix socket. The dedicated
provisioning worker must run under its own non-root UID; Linux `SO_PEERCRED` checks
that UID, independently of HTTP headers. Web/API processes must not share it or
mount this socket. The helper alone can reach the Docker socket. It accepts no
commands, environment, Compose, image names, hostnames, paths or ports in requests.

The five wire operations are POST:

| Path | Body | Result |
| --- | --- | --- |
| `/v1/capacity` | `{}` | Fresh available/total memory sample |
| `/v1/reconcile` | deploymentId, businessId, revision, leaseToken | Exact stored identity and absent/running/degraded state |
| `/v1/provision` | Same four fields | Resume the exact approved project; never rebuild or recreate existing services |
| `/v1/enrollment` | Same four fields | Native bootstrap identity and durable broker peer hash only; requires a running owned gateway |
| `/v1/verify` | Same four fields | Requires a native verifier; currently refuses with `DEPLOYMENT_NATIVE_VERIFIER_REQUIRED` |
| `/v1/sync-recovery` | Exact `ava-sync-recovery-v1` one-use claim | Separately enabled worker-only stop/restart proof; never a caller-supplied death assertion |

The helper reads the active business and unexpired deployment lease from AVA
SQLite read-only before each operation and after long-running commands. A revoked
lease after a partial or successful start stops only that project, retaining data.
The worker also checks identity/revision after every response. Unknown error text
is replaced with fixed safe codes; Docker output and credentials are not returned.

## Reviewed recipes

For each immutable deployment UUID, the release process must install root-owned
`/etc/ava/module-recipes/<uuid>/recipe.json`, `compose.json`, and any `config/`
files. Recipe/Compose files have mode 0600; parent directories cannot be symlinks
or writable by non-root. Runtime-readable config mounts may use a dedicated group,
but remain non-writable by it. The recipe is not supplied by a customer request.

Recipe schema 1 contains the exact deployment identity (business, module, revision,
hostname, namespace, pinned source commit), `composeSha256`, `imageDigest` and
`memoryMiB`. Source fields alone do not prove an image was built from that source;
release provenance and native verification remain mandatory.

The launcher validates immutable image references, exact ownership labels,
memory/CPU/PID limits, read-only roots, dropped capabilities and no privilege gain.
No host ports, host namespaces, build directives, arbitrary external networks,
external volumes, Docker mounts or Compose interpolation are accepted. Native
services remain on internal networks; only `gateway` can join approved AVA ingress
and access networks. Existing foreign containers under the same project fail
ownership checks rather than being adopted.

An optional root-owned `--image-catalogue` enables the fixed Twenty factory in
`scripts/twenty_recipe_factory.py`. It creates separate PostgreSQL/Redis, native
server/worker and an idempotent initializer. The catalogue pins the three image
IDs, source commit, and reviewed PostgreSQL/Redis UID/GID. It contains no keys.
The factory persists eight independent random secrets (ten with the gateway) before rendering private
configuration. Its preparation marker freezes the initial business name; retries
reuse both name and secrets, even if a business is renamed after a partial write.
Config/Compose changes are rejected rather than silently applied to old volumes.

PostgreSQL initialization creates a non-superuser app role; its credentials differ
from the DB owner. No bootstrap/admin secret reaches native customer requests.
The initializer calls pinned Community setup, migration, signup, activation and
role services, with a durable AVA-owned ledger and reconciliation before repeat
signup. Runtime receives only verified workspace/role IDs via a read-only volume.
The generated native subdomain retains all UUID bits within Twenty's 30-character
limit. Native passwords/sessions are not created for the internal bootstrap owner.

`initServices` are explicit recipe fields: only exited/zero initialization counts
as success. Running, failed or never-started initialization remains degraded and
resumable. Every container is inspected before returning; an initializer cannot
hide a foreign resource later in the result.

The optional `gateway` catalogue entry pins the gateway image and fixed private
broker origin `http://ava-module-access:3901`. A generated gateway mounts only
its own encryption/peer keys plus the identity-only bootstrap manifest. It does
not receive database, worker or native session encryption credentials. The broker
Compose recipe explicitly assigns the matching DNS alias. No host port is opened.

Worker enrollment is a separate hash-only prepared record in AVA SQLite. It cannot
issue grants until deployment verification and exact native integration linkage
both succeed. Retries reuse the same adapter ID/hash; changed scope/hash, a revoked
lease, integration revision changes and disabled adapters fail closed. Replaying
activation does not rotate keys or invalidate an existing verified principal.
An existing legacy adapter is never silently migrated.

An optional root-owned `--onyx-image-catalogue` independently enables
`scripts/onyx_recipe_factory.py`. Both switches may be supplied; dispatch uses the
stored module identity, never a request-supplied catalogue or path. The Onyx
catalogue also attests the installed auth extension and the gateway image UID.
The full Community recipe has fourteen services, including permanent private
`auth` and `gateway`. Only the gateway joins AVA ingress/access networks. Native
API receives its own HTTP peer key; only the auth service receives the worker
peer key. Celery workers and web do not receive either auth control key.

Auth has a minimal environment: its own DB/Redis connection, auth settings and
bucket identity needed by the namespace guard, but no search/blob credentials.
The root-prepared Onyx enrollment manifest contains identity only. Its peer hash
and stable namespace prove enrollment, **not** principal permissions, HTTPS,
successful buyer login, or RAG quality. Existing twelve-service recipes are not
silently rewritten into this new recipe.

This factory is **not yet a complete module provisioning release**. Standard CRM
record permissions now have native create/read/update proof for manager and owner,
but custom schema/runtime keys, TLS, full enrollment through buyer identity and Onyx
storage/index ACL remain separate acceptance gates. `/verify` continues
to refuse an unverified contour; healthy containers do not mark it ready.

## Recovery and capacity

The deployment registry holds reservations, 60-second leases, heartbeats,
revision fences and a lifetime limit of eight execution attempts. Retry delays
are 60, 120, 240… seconds, capped at one hour. Reconciliation precedes every
launch. `compose up --no-recreate --no-build --pull never` resumes a partial
owned project; it cannot silently replace an existing application image.

The parent provisioning job respects the deployment retry timestamp. Missing
release recipes/native verifier block the parent for operator setup without
discarding the deployment reservation. A later authorized retry preserves the
attempt count. Terminal failures/exhaustion do not implicitly reset it. Physical
cleanup and rearming an exhausted deployment require a separate reviewed flow.

Initial conservative whole-contour reservations are 4352 MiB for Twenty with
gateway (legacy native-only recipes reserve 4096 MiB) and
12800 MiB for Onyx with auth/gateway (legacy native-only recipes reserve
12288 MiB). They are not measured requirements for five hotels. The helper
does not release a reservation based on one small/idle container being running;
until peak-growth accounting is available it conservatively subtracts reservations
even from observed free memory. This can reject capacity early, but avoids
oversubscription. Load measurements must justify any smaller release budgets.

### Abandoned Twenty sync recovery (not enabled for release)

`--enable-sync-recovery` is off by default; the worker also requires
`AVA_TWENTY_SYNC_RECOVERY_ENABLED=true`. The implementation lives in
`scripts/twenty_sync_recovery_helper.py`. It independently reads the hashed
one-use claim and current business, adapter, deployment, integration, mutation
and frozen outbox before touching Docker. Only a verified, enabled, exact
Twenty deployment can restart. Disabled/replaced connections remain blocked.

Under the same deployment lock, the helper validates the full owned container
set, stops the whole exact project including PostgreSQL, verifies all old
processes are stopped, restarts the unchanged reviewed recipe, and queries
PostgreSQL to verify the new postmaster is out of recovery. Container-ID/PID
reuse is not mistaken for process identity; start timestamps must be later than
the stop observation. A replacement container is not stopped as failed-start
cleanup. The helper only emits a bounded identity-bound receipt; it cannot
release the AVA sync barrier itself.

The worker accepts that receipt transactionally into `readback_required`.
Retry remains forbidden until deterministic native readback reconciles whether
the old operation committed. That readback transition and the real delayed
native-transaction acceptance are **not yet implemented/accepted**. Never
enable these switches just because the component tests pass. See
`native_modules/twenty/SYNC_RECOVERY.md` for the remaining native gate.

## Evidence and remaining release gates

- CRM tests use real AVA SQLite and workers; upstream helper proofs are explicitly
  fixtures. They do not prove native login, schema, webhook or storage isolation.
- `tests/module-deployment-client.test.js` in `whatsapp_crm/` exercises a real
  local Unix HTTP peer, including deadlines, malformed/oversized replies and
  secret-shaped errors. That peer is a test fixture, not the privileged daemon.
- `tests/test_module_deployment_helper.py` covers request/lease/Compose checks and
  revoke races with an injected Docker runner.
- `scripts/run-module-deployment-helper-qa.py` runs real Docker/Compose against
  a fresh synthetic SQLite and an inert Node process, never real module/customer
  data. It verifies process idempotency, closed networking and cleanup. Its result
  explicitly says `native_module_acceptance=false`.

Remaining: complete module recipes, native verifier, customer schema/permissions,
durable cleanup on process crashes, exact DNS/TLS ingress, two genuine isolated
modules, browser access, native user permissions and complete guest scenarios.
Neither a running process nor a successful fixture proof closes A02–A08/A18.
