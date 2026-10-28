# Managed Exolve backend

HTTP contracts remain those in `docs/EXOLVE_IMPLEMENTATION_HANDOFF_20261012.md`.
Browser handlers only read SQLite or enqueue work. Exolve/host calls run in the
provisioning worker; no endpoint returns SIP credentials or provider errors.

## Durable operations

Each operation has a lease and durable checkpoint. The worker checks the lease
before and after external awaits. Buy/Create/Delete dispatch checkpoints are
written before the request. A lost response is reconciled from inventory and
never causes a second paid/destructive dispatch. After 20 unsuccessful attempts,
uncertain operations require operator review and keep their number/money slots.
Active-call draining does not expire its safety hold.

Number and SIP prices are checked before Lock, number prices again after Buy,
SIP fees before Create, and actual SIP fees after Create. Price drift compensates
only resources from this new, never-activated order. Compensation does not claim
that the provider refunds an installation fee. Spend remains reserved for at least 120 seconds after terminal completion,
and until a balance read that started after that settlement window returns. An older response
cannot replace a newer balance observation.

Reactivation cancels an unsent automatic release. If host removal might have
already occurred, the worker reapplies and verifies the existing endpoint before
making the DID active. A persisted Delete dispatch cannot be canceled as though
it never happened. Existing manual profile fields are restored when the last
managed number is released; unrelated manual aliases remain registered.

## Local operator recovery

`recovery.inspect(actor, operationId, provider)` and
`recovery.resume(actor, operationId, expectedRevision, provider)` are local
functions, with no HTTP mount. They require a platform operator and
`AVA_PROCESS_ROLE=provisioning-worker`. Use the initialized worker database and
provider client; never pass an API key through a browser, shell argument or report.

Inspect returns a sanitized operation, public number, revision and current
inventory presence. Resume checks application/number/SIP scope and revision,
records the last operator recovery observation, and resumes the SAME checkpoint.
It does not rewind an unknown Buy/Create/Delete, clear uncertain money, create a
new order, or remove inventory. An absent resource is not proof that Buy failed.
A routing-drift alert on a previously active phone is not a resumable purchase;
repair its routing and verify ownership/host state through the release runbook.

## Existing-number import

Explicit imports now use `existing.js`, the `/existing` inventory API and `/imports`
operation API. They require a scoped `AVA_TELEPHONY_EXISTING_BINDINGS` operator grant,
manager authorization, confirmation of availability, fresh complete inventory,
exact application/DID/SIP/CLI checks, no local active calls, verified Static IP
forwarding and host ingress. A manual alias or unknown inventory entry alone never
permits adoption. See `docs/EXOLVE_EXISTING_NUMBERS_CONTRACT.md` for the full contract.

Existing SIP mode applies existing credentials to a new owned host endpoint;
inbound-only mode creates no SIP endpoint and cannot fall back to a manual outbound
trunk. Both reserve zero purchase spend and invoke no provider mutation. Real call
verification timestamps stay empty until a recorded successful call. Imported
resources are detached, never provider-deleted, after grace and drain; saved manual
profile values and pre-existing aliases survive. Unknown inventory remains alerts.

With `AVA_TELEPHONY_WORKER_ENABLED=true`, the current provisioning-worker entrypoint
runs an independent telephony timer even if `AVA_PROVISIONING_JOBS_ENABLED=false`.
It retains identity services and does not load the general provisioning queue.
With the general queue enabled there is no second telephony timer. Do not replace
the production identity worker CMD with the optional standalone telephony sidecar.
With purchases disabled, purchase/quote jobs are not leased and managed provider
Delete is blocked. Catalog/inventory/host health continue independently.

The local operator command is `node telephony-import-existing.js <businessId>
<DID> <sip|inbound_only> <idempotency-key> --confirm-unused`. It requires the same
scoped grant and cannot bypass missing forwarding, host health or provider checks.
No provider credential belongs in command arguments or reports.

## Local verification

Run from `whatsapp_crm`:

```sh
node --test tests/managed-telephony.test.js
node tests/run-tests.js business-provisioning provisioning-hardening provisioning-lifecycle identity-only-worker worker-startup-safety
node tests/run-tests.js customer-role-boundary customer-outbound-attempts customer-workspace
```

These use local SQLite, real Express/auth middleware and controlled provider/host
fakes. They do not prove Exolve account entitlement, real SIP registration, media,
Caller ID, transfer, recordings or production acceptance.
