# Twenty native QA probe

Run only against a new, disposable database named `ava_native_qa_*`. Bootstrap
uses Twenty's own `SignInUpService.signUpOnNewWorkspace`, `WorkspaceService`
activation and `RoleService.createRole`; it does not insert fixtures. From the
already-built QA Twenty container, with `NODE_OPTIONS` unset, run:

`AVA_NATIVE_QA=true AVA_QA_DATABASE_NAME=ava_native_qa_run1 AVA_QA_CONTEXT_FILE=/run/ava-qa/context.json node /app/packages/twenty-server/dist/ava-native/qa/bootstrap.cjs`

Also supply `PG_DATABASE_URL` for that exact empty DB plus `AVA_QA_BUSINESS_ID`,
`AVA_QA_DEPLOYMENT_ID`, and `AVA_QA_REVISION`. The context is created mode 0600;
use its `nativeScope`, `managerRoleId`, and `hotelOwnerRoleId` when starting the
adapter-enabled QA server. Bootstrap readbacks require an ACTIVE workspace,
immutable synthetic owner, and two non-admin roles.

The probe receives both peer secrets solely from `*_FILE` paths. Execute:

1. `AVA_QA_MODE=mint` — provisions a synthetic user and mints a real native session.
2. `AVA_QA_MODE=resolve` — resolves it through the real guarded GraphQL server.
3. Kill/restart only the disposable Twenty server container, then repeat `resolve`.
4. `AVA_QA_MODE=revoke` — calls the real native revoke path and confirms guarded GraphQL is denied.

Before the HTTP probe, run `node /app/packages/twenty-server/dist/ava-native/qa/verify-graphql-ast.cjs`
inside the rebuilt QA image. It uses that image's installed `graphql` parser to
check alias/fragment denial; its exit status is the evidence.

Set `AVA_NATIVE_QA=true` and `AVA_QA_PRIVATE_HOSTS` to the exact comma-separated
container DNS names used by both `AVA_QA_PEER_URL` and `AVA_QA_TWENTY_URL`.
The probe rejects other origins, responses over ten seconds, GraphQL `errors`,
or a session/user readback that differs from the minted native IDs.

The persisted context file contains a short-lived QA cookie and must be deleted
with the disposable QA environment after the run. Secrets are never printed.
