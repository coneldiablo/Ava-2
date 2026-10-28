#!/usr/bin/env bash
# Read a decrypted custom-format pg_dump from stdin. Restore ONLY into a newly
# created, network-isolated, ephemeral PostgreSQL container. Never into live DB.
set -Eeuo pipefail
umask 077

if [[ "${1:-}" != "--isolated-from-stdin" || -t 0 ]]; then
  echo 'Usage: decrypt-backup | verify-twenty-restore.sh --isolated-from-stdin' >&2
  exit 2
fi

source_container=ava-twenty-db-1
image="$(docker inspect --format '{{.Image}}' "$source_container")"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
# Identity lookup is read-only. No live env, password, mounts or network copied.
uid="$(docker exec "$source_container" id -u postgres)"
gid="$(docker exec "$source_container" id -g postgres)"
[[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]]
name="ava-twenty-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"
label="ava.restore-rehearsal=$name"
container_id=''

cleanup() {
  local status=$?
  if [[ -n "$container_id" ]]; then
    # Delete only this invocation's exact ID with its matching ownership label.
    if [[ "$(docker inspect --format '{{index .Config.Labels "ava.restore-rehearsal"}}' "$container_id" 2>/dev/null)" == "$name" ]]; then
      if docker rm --force "$container_id" >/dev/null; then
        echo 'temporary_container_removed=true'
      else
        echo 'temporary_container_cleanup_failed' >&2
        status=1
      fi
    else
      echo 'temporary_container_ownership_check_failed' >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container_id="$(docker run --detach --pull never --name "$name" --label "$label" \
  --network none --read-only --user "$uid:$gid" --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 768m --cpus 1 --pids-limit 128 \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=512m,uid=$uid,gid=$gid,mode=0700" \
  --tmpfs "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,uid=$uid,gid=$gid,mode=0700" \
  --tmpfs "/tmp:rw,nosuid,nodev,noexec,size=32m,uid=$uid,gid=$gid,mode=0700" \
  -e POSTGRES_USER=twenty -e POSTGRES_DB=twenty_restore \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" \
  postgres -c listen_addresses= -c shared_buffers=32MB -c max_connections=10)"
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container_id")" == none ]]
[[ "$(docker inspect --format '{{len .HostConfig.Binds}}' "$container_id")" == 0 ]]
[[ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$container_id")" == 0 ]]
ready=0
for _ in {1..30}; do
  # pg_isready alone also succeeds against entrypoint's temporary init server,
  # which is subsequently stopped. Wait until PostgreSQL itself owns PID 1.
  if docker exec "$container_id" sh -c \
    'test "$(cat /proc/1/comm)" = postgres && pg_isready -U twenty -d twenty_restore' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'isolated_database_start_failed' >&2; exit 1; }
echo "isolation=network_none_no_ports_tmpfs image=$image"

# Errors may contain row values: keep raw output only in ephemeral tmpfs.
if ! docker exec -i "$container_id" sh -c \
  'pg_restore --exit-on-error --no-owner --no-privileges -U twenty -d twenty_restore 2>/tmp/restore-errors'; then
  echo 'isolated_pg_restore_failed_raw_errors_not_printed' >&2
  # Emit only fixed classifications, never the raw SQL, row data or credentials.
  docker exec "$container_id" sh -c '
    for code in "server closed" "database .* does not exist" "not a valid archive" \
      "unsupported version" "could not read" "already exists" "permission denied" \
      "out of memory" "No space left"; do
      if grep -qi "$code" /tmp/restore-errors; then printf "restore_error_class=%s\n" "$code"; fi
    done' >&2
  exit 1
fi
echo 'pg_restore_exit=0'

# Check every restored user table/index and known links, not just command status.
# Data and credentials are never printed; only aggregate counts and booleans.
docker exec -i "$container_id" psql -X -U twenty -d twenty_restore \
  -v ON_ERROR_STOP=1 -At <<'SQL'
SET default_transaction_read_only = on;
DO $verify$
DECLARE
  workspace_schema text;
  table_total integer;
  task_count integer;
BEGIN
  SELECT count(*) INTO table_total FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';
  IF table_total < 110 THEN RAISE EXCEPTION 'RESTORE_USER_TABLES_MISSING'; END IF;
  IF (SELECT count(*) FROM core.workspace WHERE id='72600089-b4b4-4db3-a8b9-362f07033467'
      AND "activationStatus"='ACTIVE') <> 1 THEN RAISE EXCEPTION 'RESTORE_WORKSPACE_MISSING'; END IF;
  IF (SELECT count(*) FROM core."user" WHERE id='6159f816-c6f8-43b5-861f-7b382f47e870'
      AND "canAccessFullAdminPanel"=true AND disabled=false AND "deletedAt" IS NULL) <> 1
      THEN RAISE EXCEPTION 'RESTORE_OWNER_MISSING'; END IF;
  IF (SELECT count(*) FROM core."userWorkspace" WHERE "userId"='6159f816-c6f8-43b5-861f-7b382f47e870'
      AND "workspaceId"='72600089-b4b4-4db3-a8b9-362f07033467') <> 1
      THEN RAISE EXCEPTION 'RESTORE_MEMBERSHIP_MISSING'; END IF;
  IF (SELECT count(*) FROM core."apiKey" WHERE "workspaceId"='72600089-b4b4-4db3-a8b9-362f07033467') < 1
      THEN RAISE EXCEPTION 'RESTORE_INTEGRATION_KEY_MISSING'; END IF;
  SELECT table_schema INTO STRICT workspace_schema FROM information_schema.tables
    WHERE table_name='task' AND table_schema LIKE 'workspace\_%' ESCAPE '\';
  EXECUTE format('SELECT count(*) FROM %I.task WHERE id=$1 AND status::text=$2 AND "avaBusinessId"=$3',workspace_schema)
    INTO task_count USING 'b0769054-5bf5-5a8b-bef8-d57319ce5183'::uuid,'DONE','1';
  IF task_count <> 1 THEN RAISE EXCEPTION 'RESTORE_AVA_TASK_LINK_MISSING'; END IF;
  IF EXISTS (SELECT 1 FROM pg_index WHERE NOT indisvalid OR NOT indisready)
      THEN RAISE EXCEPTION 'RESTORE_INVALID_INDEX'; END IF;
END $verify$;
SELECT 'user_tables=' || count(*) FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';
SELECT 'restored_schema=' || table_schema || ' tables=' || count(*) FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
  GROUP BY table_schema ORDER BY table_schema;
SELECT 'workspace_owner_membership_api_key_task_verified=true';
SQL
echo 'isolated_restore_verified=true production_restore_performed=false'
