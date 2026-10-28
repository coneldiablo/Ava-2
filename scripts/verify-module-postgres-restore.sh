#!/usr/bin/env bash
# Decrypted pg_dump on stdin -> isolated tmpfs-only PostgreSQL -> destroy.
# No live mounts, ports, network or credentials enter the temporary database.
set -Eeuo pipefail
umask 077
module="${1:-}"; expected_tables="${2:-}"
[[ $module == twenty || $module == onyx || $module == identity ]]
[[ $expected_tables =~ ^[0-9]+$ && $expected_tables -gt 0 && ! -t 0 ]]
source_container=ava-twenty-db-1
[[ $module != onyx ]] || source_container=onyx-relational_db-1
[[ $module != identity ]] || source_container=ava-identity-database-1
image="$(docker inspect --format '{{.Image}}' "$source_container")"
[[ $image =~ ^sha256:[0-9a-f]{64}$ ]]
uid="$(docker exec "$source_container" id -u postgres)"
gid="$(docker exec "$source_container" id -g postgres)"
name="ava-restore-$module-$(date -u +%Y%m%dT%H%M%SZ)-$$"
container=''
cleanup() {
  local status=$?
  if [[ -n $container ]]; then
    if [[ $(docker inspect --format '{{index .Config.Labels "ava.restore-rehearsal"}}' "$container") == "$name" ]]; then
      docker rm -fv "$container" >/dev/null || status=1
    else status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
container="$(docker run --detach --pull never --name "$name" --label "ava.restore-rehearsal=$name" \
  --network none --read-only --user "$uid:$gid" --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --cpus 1 --pids-limit 128 \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=768m,uid=$uid,gid=$gid,mode=0700" \
  --tmpfs "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,uid=$uid,gid=$gid,mode=0700" \
  --tmpfs "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=$uid,gid=$gid,mode=0700" \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=ava_restore -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" postgres -c listen_addresses= -c shared_buffers=32MB -c max_connections=10)"
[[ $(docker inspect --format '{{.HostConfig.NetworkMode}} {{len .HostConfig.Binds}} {{len .HostConfig.PortBindings}}' "$container") == 'none 0 0' ]]
ready=0
for _ in {1..30}; do
  if docker exec "$container" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres -d ava_restore' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
if ! docker exec -i "$container" sh -c 'pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d ava_restore 2>/tmp/private-restore-errors'; then
  echo 'ISOLATED_POSTGRES_RESTORE_FAILED_RAW_ERRORS_NOT_PRINTED' >&2; exit 1
fi
tables="$(docker exec "$container" psql -X -U postgres -d ava_restore -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'")"
[[ $tables == "$expected_tables" ]]
[[ $(docker exec "$container" psql -X -U postgres -d ava_restore -Atc 'SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready') == 0 ]]
docker exec "$container" vacuumdb -U postgres -d ava_restore --analyze-only --quiet
printf 'module=%s pg_restore=ok user_tables=%s indexes=valid network=none live_mounts=none production_restore=false\n' "$module" "$tables"
