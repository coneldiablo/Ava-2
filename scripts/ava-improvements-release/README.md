# AVA improvements CRM release operator

Run `release_operator.py` on the production Docker host with Python 3.10+.
The operator has no SSH or upload behavior. Packaging and transferring the
reviewed bundle are separate steps controlled by the release coordinator.

Bundle layout:

```text
manifest.json
migrations.cjs
src/<only the manifest sourceFiles>
frontend-dist/<the built frontendFiles>
```

Manifest version 1 requires:

```json
{
  "schemaVersion": 1,
  "baseCommit": "<40 hex base release commit>",
  "candidateCommit": "<40 hex final integration commit>",
  "baseImageId": "sha256:<64 hex pinned live image>",
  "candidateTag": "ava-improvements-crm:<candidate commit prefix>",
  "sourceFiles": {"services/example.service.js": "<sha256>"},
  "baseSourceFiles": {"services/example.service.js": "<reviewed Git base sha256, or null for a new file>"},
  "frontendFiles": {"index.html": "<sha256>", "assets/index-example.js": "<sha256>"},
  "migrationRunner": {"path": "migrations.cjs", "sha256": "<sha256>"},
  "allowedNewSchema": [
    {"name": "<exact name>", "type": "table", "tbl_name": "<exact table>", "sqlHash": "<sha256 of sqlite_master.sql or empty string>"}
  ],
  "businesses": "*",
  "publicBaseUrl": "https://wh.meludtech.tech",
  "publicRoutes": ["/", "/today"]
}
```

`businesses` also accepts a nonempty list of business IDs. Include every new
table, index (including SQLite autoindexes), and trigger in `allowedNewSchema`.
Derive those entries from the real pinned baseline schema and candidate runner;
do not handwrite SQL hashes. The pinned runner accepts `migrate` and `compat`,
an explicit absolute `DB_PATH`, and emits exactly `{"schemaVerified":true}` on
success. It must never start the application. The coordinator supplies
`scripts/ava-improvements-migrate.cjs` as the bundle's `migrations.cjs`.
`baseSourceFiles` must have exactly the same keys as `sourceFiles`. Before a
replacement, its live source hash must match the reviewed base commit's hash;
new files marked `null` must be absent from the installed image. This protects
production-only hotfixes in files that the overlay would otherwise replace.

Use the same explicit arguments for every operation:

```sh
python3 release_operator.py prepare \
  --bundle /root/ava-releases/<release>/bundle \
  --release-dir /root/ava-releases/<release>/operator-state \
  --base-image sha256:b3e248e5de78ff3dde3fac5bec810aa38acfbbdd452a08e4986c8a16b463a661 \
  --candidate-commit <final-40-hex-commit> \
  --manifest-sha256 <reviewed-manifest-sha256>
```

Replace `prepare` with `verify`, `apply`, or `rollback` as authorized:

| Operation | Result |
| --- | --- |
| `prepare` | Capture live contracts, build from the pinned installed image, preserve old frontend chunks, verify the whole `/app` runtime outside the DB bind, save an online SQLite backup, test exact additive migration and idempotence, check old-image compatibility, and save private Compose overrides. |
| `verify` before apply | Recheck the pinned live baseline, candidate and ordered Compose inputs; make a fresh backup and repeat the migration check. |
| `apply` | Make a fresh online backup; repeat migration preservation and rollback compatibility checks; migrate the live DB using the isolated runner; recreate only CRM; verify health, zero restarts, unchanged other containers, environment, mounts, runtime bytes and public HTTPS bytes. |
| `verify` after apply | Verify installed image, environment, bind, runtime bytes, health, other container identities and HTTPS bytes. |
| `rollback` | Back up the current DB, test old-image compatibility, recreate only CRM with the original environment and pinned old image, and verify the old executable/static payload. The current DB is retained. |

All Compose files and env files are discovered in their existing order from the
live CRM labels. Actual container environment values override differences from
disk, including values containing `$`; the sole new environment key is
`AVA_IMPROVEMENTS_BUSINESSES`. Files and credentials are captured privately with
mode 0600. Command failures write a private log and print only a safe error code.
No customer rows or environment values appear in stdout receipts.

Backups use SQLite's online backup API, including uncheckpointed WAL data, then
fsync and SHA-256. Integrity, row hashing, and compatibility checks use the
images' `better-sqlite3` and `sqlite-vec`, including vector tables. Migration
checks require every original schema object and every original table's row
multiset to remain identical on the backup copy; only the exact declared new
objects are allowed. Production writers continue running during the additive
schema transaction. The live DB is never restored from a backup.

Apply failures attempt the same scoped old-image rollback and report failure
even if recovery succeeds. If both apply and rollback fail, inspect the private
command log and current CRM state before retrying. Preserve the operator-state
directory for rollback and receipts. The operator does not remove old images,
backups, Compose files, or release directories.
If `prepare` fails before saving `prepared.private.json`, use a fresh
`--release-dir` for the next attempt and retain the failed directory for
inspection. Its staged candidate image and private backup may already exist;
production CRM is still running the original image. Build uses a local base
tag whose content ID is checked against `--base-image` before and after build.

The final receipt proves installed runtime/static bytes and health. Business
workflow acceptance remains a separate customer-facing check.

Local tests (no Docker or production access):

```sh
python3 -m unittest discover -s scripts/ava-improvements-release -p 'test_*.py' -v
```
