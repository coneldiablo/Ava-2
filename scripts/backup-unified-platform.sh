#!/usr/bin/env bash
# Run over SSH and pipe stdout DIRECTLY into local encryption. The encryption
# key never visits the server. No production restore and no retention deletion.
set -Eeuo pipefail
umask 077
[[ ${1:-} == --stream-consistent ]] || { echo 'Explicit --stream-consistent required' >&2; exit 2; }
project="$(readlink -f /root/ava-current)"
[[ $project == /root/ava-releases/* && -f $project/docker-compose.yml ]]
stage="$(mktemp -d /root/backups/ava/.unified-snapshot.XXXXXX)"
paused=()
resume() {
  local failed=0 container
  for container in "${paused[@]}"; do
    docker unpause "$container" >/dev/null || failed=1
  done
  if [[ $failed == 0 ]]; then paused=(); fi
  return "$failed"
}
cleanup() {
  local status=$?
  resume || { echo 'BACKUP_RESUME_FAILED_CHECK_CONTAINERS' >&2; status=1; }
  rm -rf -- "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$stage"/{sqlite,postgres,volumes,system,source,manifests}
asterisk -rx 'core show channels count' | grep -qx '0 active calls' || {
  echo 'ACTIVE_CALLS_BACKUP_DEFERRED' >&2; exit 1;
}
writers=(ai_engine admin_ui whatsapp_crm whatsapp_crm_openwa ava-twenty-server-1 ava-twenty-worker-1 onyx-api_server-1 onyx-background-1)
identity_db=ava-identity-database-1
identity_keycloak=ava-identity-keycloak-1
identity_worker=asterisk-ai-voice-agent-provisioning_worker-1
identity_installed=false
identity_containers="$(docker ps -a --no-trunc --format '{{.Names}}')"
# This compose project is optional for older deployments. If either service
# exists, require the complete expected stack rather than silently omitting it.
if grep -Fxq "$identity_db" <<< "$identity_containers" || grep -Fxq "$identity_keycloak" <<< "$identity_containers"; then
  grep -Fxq "$identity_db" <<< "$identity_containers"
  grep -Fxq "$identity_keycloak" <<< "$identity_containers"
  [[ $(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }} {{ index .Config.Labels "com.docker.compose.service" }}' "$identity_db") == 'ava-identity database' ]]
  [[ $(docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$identity_db") == 'true false' ]]
  identity_database_name="$(docker exec "$identity_db" sh -c 'printf %s "$POSTGRES_DB"')"
  [[ $identity_database_name == ava_identity ]]
  [[ $(docker ps -a --no-trunc --format '{{.Names}}' | grep -Fx "$identity_keycloak") == "$identity_keycloak" ]]
  [[ $(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }} {{ index .Config.Labels "com.docker.compose.service" }}' "$identity_keycloak") == 'ava-identity keycloak' ]]
  identity_workdir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$identity_db")"
  case "$identity_workdir" in
    /opt/ava-identity|"$project/deploy/keycloak") ;;
    *) echo 'KEYCLOAK_WORKDIR_UNTRUSTED' >&2; exit 1 ;;
  esac
  [[ -d $identity_workdir && ! -L $identity_workdir ]]
  [[ $(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$identity_keycloak") == "$identity_workdir" ]]
  identity_config_files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$identity_db")"
  [[ -n $identity_config_files ]]
  IFS=',' read -r -a configured_files <<< "$identity_config_files"
  allowed_identity_files=(.env web.env worker.env docker-compose.yml pilot-network.override.yml ava-realm.json Dockerfile nginx.conf nginx-http.conf user-profile.json)
  for configured_file in "${configured_files[@]}"; do
    [[ $(dirname "$configured_file") == "$identity_workdir" ]]
    configured_name="$(basename "$configured_file")"
    [[ " ${allowed_identity_files[*]} " == *" $configured_name "* ]]
    [[ -f $configured_file && ! -L $configured_file ]]
  done
  [[ $(docker ps -a --no-trunc --format '{{.Names}}' | grep -Fx "$identity_worker") == "$identity_worker" ]]
  [[ $(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$identity_worker") == 'provisioning_worker' ]]
  # Pause Keycloak to keep application writes quiescent, but leave PostgreSQL
  # running: pg_dump needs to execute inside that container below.
  writers+=("$identity_keycloak" "$identity_worker")
  identity_installed=true
fi
for container in "${writers[@]}"; do
  [[ $(docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container") == 'true false' ]]
done
docker inspect --format '{{.Name}} {{.Image}} {{.Config.Image}}' "${writers[@]}" > "$stage/manifests/images.txt"
docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' > "$stage/manifests/containers.txt"
docker inspect $(docker ps -q) > "$stage/manifests/docker-inspect.private.json"
date -u +%FT%TZ > "$stage/manifests/started-utc.txt"
printf '%s\n' "$project" > "$stage/manifests/source-path.txt"
if git -C "$project" rev-parse HEAD > "$stage/manifests/git-head.txt" 2>/dev/null; then
  git -C "$project" status --short > "$stage/manifests/git-status.txt"
  git -C "$project" diff --binary HEAD > "$stage/manifests/live-diff.private.patch"
fi
for container in "${writers[@]}"; do
  paused+=("$container")
  docker pause "$container" >/dev/null
done
echo 'BACKUP_WRITERS_PAUSED' >&2
python3 - "$project" "$stage/sqlite" <<'PY'
import pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2])
for source,name in [(root/'data/whatsapp_crm/crm_v2.db','crm_v2.db'),(root/'data/call_history.db','call_history.db')]:
    with sqlite3.connect(f'file:{source}?mode=ro',uri=True,timeout=20) as live, sqlite3.connect(target/name) as dest:
        live.backup(dest)
        assert dest.execute('PRAGMA quick_check').fetchone()[0]=='ok'
PY
postgres_pairs=('ava-twenty-db-1 twenty' 'onyx-relational_db-1 onyx')
if [[ $identity_installed == true ]]; then postgres_pairs+=("$identity_db identity"); fi
for pair in "${postgres_pairs[@]}"; do
  read -r container module <<< "$pair"
  docker exec "$container" sh -c 'exec pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$stage/postgres/$module-globals.sql"
  # Never infer the live database from the module name or POSTGRES_DB. A
  # migrated install can keep its real data in `postgres` and an empty `onyx`.
  mapfile -t databases < <(docker exec "$container" sh -c 'exec psql -X -U "$POSTGRES_USER" -d postgres -Atc "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname"')
  [[ ${#databases[@]} -gt 0 ]]
  for database in "${databases[@]}"; do
    [[ $database =~ ^[a-zA-Z0-9_-]+$ ]]
    name="$module--$database"
    printf '%s\t%s\t%s\n' "$module" "$database" "$name.dump" >> "$stage/manifests/postgres-databases.tsv"
    docker exec "$container" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$1" --lock-wait-timeout=20s -Fc' sh "$database" > "$stage/postgres/$name.dump"
    docker exec -i "$container" pg_restore -l < "$stage/postgres/$name.dump" > "$stage/manifests/$name-restore-list.txt"
    docker exec "$container" sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$1" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('"'"'pg_catalog'"'"','"'"'information_schema'"'"') AND table_type='"'"'BASE TABLE'"'"'"' sh "$database" > "$stage/manifests/$name-table-count.txt"
  done
done
# Capture only explicitly approved Keycloak deployment files from the actual
# Compose working directory. Secrets stay in the encrypted archive, never in
# manifests/stdout; do not follow symlinks or copy arbitrary directory content.
if [[ $identity_installed == true ]]; then
  [[ -s $identity_workdir/docker-compose.yml && -s $identity_workdir/ava-realm.json ]]
  identity_bundle_files=()
  for name in "${allowed_identity_files[@]}"; do
    if [[ -e $identity_workdir/$name ]]; then
      [[ -f $identity_workdir/$name && ! -L $identity_workdir/$name ]]
      identity_bundle_files+=("$name")
    fi
  done
  tar -C "$identity_workdir" -cf "$stage/source/keycloak-state.tar" "${identity_bundle_files[@]}"
  printf 'true\n' > "$stage/manifests/keycloak-installed.txt"
fi
# Freeze file stores while taking their byte-for-byte snapshots. PostgreSQL is
# represented by logical dumps, never by a copy of a running PGDATA directory.
for container in onyx-minio-1 onyx-opensearch-1 whatsapp_crm_redis ava-twenty-redis-1 onyx-cache-1; do
  [[ $(docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container") == 'true false' ]]
  paused+=("$container"); docker pause "$container" >/dev/null
done
for volume in asterisk-ai-voice-agent_whatsapp_crm_openwa_data ava-twenty_server-local-data ava-twenty_redis-data onyx_minio_data onyx_opensearch-data onyx_file-system; do
  mount="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
  [[ $mount == /var/lib/docker/volumes/*/_data && -d $mount ]]
  tar -C "$mount" -cf "$stage/volumes/$volume.tar" .
done
# Discover both AVA/Onyx Redis persistence mounts; image-backed AVA Redis may
# have an anonymous Docker volume rather than the historical Compose name.
for container in whatsapp_crm_redis onyx-cache-1; do
  mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container")"
  if [[ $mount == /var/lib/docker/volumes/*/_data && -d $mount ]]; then
    tar -C "$mount" -cf "$stage/volumes/$container-data.tar" .
  fi
done
tar -C "$project" --exclude='./data/whatsapp_crm/crm_v2.db*' --exclude='./data/call_history.db*' \
  --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.git' --exclude='./models' \
  --exclude='./.venv*' --exclude='*/__pycache__' --exclude='*.pyc' -cf "$stage/source/live-tree.tar" .
# Versioned releases can share their data/media through top-level symlinks.
# Archive those two approved roots explicitly; never dereference arbitrary
# symlinks in the source tree, and never copy live SQLite/WAL as database backup.
for name in data asterisk_media; do
  if [[ -L "$project/$name" ]]; then
    runtime="$(readlink -f "$project/$name")"
    [[ $runtime == /root/ava-releases/*/"$name" && -d $runtime ]]
    tar -C "$runtime" --exclude='./whatsapp_crm/crm_v2.db*' --exclude='./call_history.db*' \
      -cf "$stage/source/runtime-$name.tar" .
  fi
done
for path in /etc/asterisk /etc/nginx /etc/letsencrypt /etc/systemd/system /etc/ssh /etc/ufw /etc/fail2ban /etc/docker /root/.ava-secrets /root/.xray-client /opt/ava-deploy /opt/onyx-v4.7.0/deployment/docker_compose; do
  if [[ -e $path ]]; then cp -a --parents "$path" "$stage/system/"; fi
done
resume
echo 'BACKUP_WRITERS_RESUMED' >&2
date -u +%FT%TZ > "$stage/manifests/completed-utc.txt"
(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar -C "$stage" -czf - .
