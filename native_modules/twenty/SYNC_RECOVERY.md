# Twenty sync-lease recovery gate

Status: local durable implementation and helper contract are present, but both
the worker loop (`AVA_TWENTY_SYNC_RECOVERY_ENABLED=true`) and privileged helper
route (`--enable-sync-recovery`) are disabled by default. The native HTTP sync
guard must remain disconnected until the disposable real-contour acceptance
below passes and a separate release is authorized.

## Safety invariant

An `ava-sync-lease-v1` lease stays `active` after expiry, adapter disable, or an
HTTP disconnect. None of those events proves that the native handler or its
PostgreSQL transaction stopped writing.

`completed`, `failed`, and `denied` are terminal responses from a handler that
returned. `fenced` is terminal only when either:

1. the post-acquire native ledger recheck fails before `next()` dispatches the
   Twenty handler; or
2. the privileged recovery flow below proves the old native process and its
   database-writing capability are gone.

`abandoned` is diagnostic only. It must persist as
`outcome=abandoned_pending_death` while `status=active` continues to block a
replacement binding and lease.

## Why smaller signals are unsafe

- Lease TTL is admission freshness, not cancellation.
- A client socket close does not cancel an Express/Nest handler.
- Stopping only the gateway or native container does not immediately prove that
  PostgreSQL has observed every broken connection and ended its transaction.
- A Docker container ID is normally reused by `docker compose stop`/`start`;
  compare host PID and `State.StartedAt`, not only the container ID.
- A restarted PostgreSQL backend may reuse a backend PID. Database process start
  time and completion of crash recovery are the meaningful boundary.
- Recovery cannot prove whether a transaction committed just before shutdown.
  It proves only that the old transaction cannot continue. Deterministic record
  IDs and exact readback must reconcile the commit-or-rollback result.

## Smallest control-plane hook

Reuse the existing provisioning worker, root-owned deployment helper Unix
socket, immutable recipe, deployment labels, and per-deployment `.launch.lock`.
Do not expose recovery through the browser, module gateway, native peer server,
or public broker.

The AVA store mints a one-use recovery lease only for an active sync lease
whose admission TTL expired or whose outcome is `abandoned_pending_death` or
`disable_pending`. Suggested private request contract:

```json
{
  "contractVersion": "ava-sync-recovery-v1",
  "recoveryId": "uuid",
  "recoveryToken": "uuid",
  "leaseId": "uuid",
  "deploymentId": "uuid",
  "businessId": 1,
  "leaseRevision": 1,
  "deploymentRevision": 1,
  "adapterRevision": 1,
  "integrationRevision": 1,
  "correlationId": "uuid-or-twout_uuid",
  "outboxEventId": "uuid-or-twout_uuid"
}
```

The helper independently reads the CRM SQLite registry and verifies the
hashed recovery token, active sync lease, adapter/deployment/business binding,
eligible outcome or expiry, immutable recipe, Compose project, and labels. No
request may supply a path, Compose document, image, command, service name,
container ID, or PID.

While holding `.launch.lock`, the helper must:

1. snapshot the helper-discovered native and database container IDs, host PIDs,
   and `State.StartedAt` values;
2. stop the entire exact deployment Compose project, including gateway,
   native, worker, cache, and PostgreSQL, with bounded graceful stop followed by
   Docker's forced termination;
3. re-inspect the complete label-owned/project-owned container set and require
   every process to have `Running=false`, `Restarting=false`, and `Pid=0`;
4. specifically require the deployment PostgreSQL process to be stopped;
5. restart only the already-reviewed Compose recipe with `--no-build`,
   `--pull never`, and `--no-recreate`;
6. require healthy native and PostgreSQL services and later `State.StartedAt`
   values; container IDs and host PIDs can be reused, and PID inequality alone
   does not prove the boundary; and
7. return an exact identity-bound proof containing the recovery/lease IDs,
   deployment/business/revision, old and new process observations, whole-project
   stop proof, database restart proof, and final healthy state.

The sync lease remains active throughout helper stop/restart. A newly started
native process therefore cannot acquire the same correlation before the
provisioning worker atomically accepts the exact recovery proof. Only that final
AVA transaction may set the lease to `fenced`, record
`outcome=process_death_proven`, and retain/fail the corresponding outbox row for
deterministic reconciliation.

Proof acceptance currently stops at durable `readback_required`. Both producer
preparation and a replacement sync lease for that correlation are denied in
that state. The native deterministic-record readback and the terminal
`completed` transition are intentionally not implemented yet; there is no
manual flag or caller-supplied boolean that can skip them. Consequently this
recovery package is fail-closed and is not, by itself, permission to retry the
mutation or enable the native HTTP sync guard.

A lost helper response is safe: the active barrier remains and a retry repeats
the same whole-contour stop/restart. Any mismatch or partial observation fails
closed and leaves both the barrier and capacity reservation intact.

## Expected implementation locations

- `whatsapp_crm/src/services/identity/module-access-store.js`: durable recovery
  lease/token/proof state and the worker-only terminal fencing transaction.
- `whatsapp_crm/src/services/identity/sync-lease-recovery-worker.js`: one-job
  worker orchestration without external calls inside SQLite transactions.
- `whatsapp_crm/provisioning-worker.js`: invoke the recovery worker from the
  existing worker lifecycle and include it in graceful shutdown.
- `whatsapp_crm/src/services/provisioning/module-deployment-client.js`: exact
  private helper request/response contract and safe error codes.
- `scripts/module_deployment_helper.py` and `scripts/twenty_sync_recovery_helper.py`:
  recovery validation, launch locking, whole-project stop, process inspection,
  reviewed restart, and proof creation.
- `scripts/twenty_sync_recovery_helper.py`: exact Twenty recovery execution and
  PostgreSQL restart/crash-recovery observation used by the root helper route.
- Focused CRM/helper tests plus a disposable native acceptance probe.

No recipe or preload change is required merely to recover a lease. HTTP guard
wiring is a separate gate: the current Twenty install guard rejects API-key
`Authorization`, the gateway strips it and admits browser sessions only, and
the native container does not own the broker-peer secret. Do not weaken those
boundaries as a shortcut.

## Evidence required before wiring

Local tests may prove validation, state transitions, wrong-scope/token/revision
denial, command construction, label ownership, response-loss retry, container-ID
reuse handling, and that retrying an outbox row cannot replace an abandoned
active lease.

Native acceptance must use a new disposable Twenty contour and must prove:

1. a real native handler keeps running a delayed PostgreSQL transaction after
   its HTTP client disconnects;
2. `abandoned_pending_death` keeps acquisition and producer preparation blocked;
3. recovery stops the entire test contour, explicitly including PostgreSQL;
4. all old host processes are absent before restart;
5. PostgreSQL completes restart/crash recovery and no pre-stop transaction can
   continue;
6. the native and database process identities change even if container IDs do
   not;
7. commit-before-death and rollback-on-death both reconcile through the same
   deterministic record ID without a duplicate or cross-tenant write;
8. a lost recovery response is idempotently recoverable;
9. a foreign deployment, business, revision, lease, token, container, or Compose
   project is never stopped; and
10. no customer or unrelated test contour loses availability.

Run recovery acceptance only within the authorized disposable QA scope,
including its database; never silently substitute an existing customer contour.
Production recovery requires a separately reviewed release and authorization
for that production operation. SSH is a transport, not proof of either scope
or authorization.
