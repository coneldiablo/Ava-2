#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

COMPOSE_DIR="${ONYX_COMPOSE_DIR:-/opt/onyx-v4.7.0/deployment/docker_compose}"
BACKUP_ROOT="${ONYX_BACKUP_ROOT:-/root/backups/ava/onyx}"
TIMESTAMP="${AVA_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
BASE_COMPOSE="${COMPOSE_DIR}/docker-compose.prod-no-letsencrypt.yml"
OVERRIDE_COMPOSE="${COMPOSE_DIR}/docker-compose.ava-production.yml"
ARCHIVE_IMAGE="docker.io/library/postgres:15.2-alpine"

compose() {
  docker compose -f "$BASE_COMPOSE" -f "$OVERRIDE_COMPOSE" "$@"
}

resume_stack() {
  if [[ "${STACK_STOPPED:-0}" == "1" ]]; then
    compose up -d --wait --wait-timeout 900
  fi
}

trap resume_stack EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/data" "$BACKUP_DIR/manifests"
chmod 700 "$BACKUP_DIR"

cd "$COMPOSE_DIR"

git -C /opt/onyx-v4.7.0 rev-parse HEAD > "$BACKUP_DIR/manifests/git-commit.txt"
git -C /opt/onyx-v4.7.0 status --short > "$BACKUP_DIR/manifests/git-status.txt"
compose config --images > "$BACKUP_DIR/manifests/images.txt"
compose config > "$BACKUP_DIR/manifests/compose.resolved.yml"
docker inspect $(compose ps -q) > "$BACKUP_DIR/manifests/container-inspect.json"

install -m 600 .env "$BACKUP_DIR/config/onyx.env"
install -m 600 .env.nginx "$BACKUP_DIR/config/onyx.env.nginx"
install -m 600 "$BASE_COMPOSE" "$BACKUP_DIR/config/docker-compose.base.yml"
install -m 600 "$OVERRIDE_COMPOSE" "$BACKUP_DIR/config/docker-compose.production.yml"
install -m 600 /etc/nginx/sites-available/ava-integrations "$BACKUP_DIR/config/host-nginx.conf"
install -m 600 /etc/ssh/sshd_config.d/00-ava-hardening.conf "$BACKUP_DIR/config/ssh-hardening.conf"
install -m 600 /etc/docker/daemon.json "$BACKUP_DIR/config/docker-daemon.json"
install -m 600 /etc/letsencrypt/renewal/203.0.113.10.conf "$BACKUP_DIR/config/letsencrypt-renewal.conf"
tar -czf "$BACKUP_DIR/config/letsencrypt.tar.gz" -C /etc letsencrypt
if [[ -d /root/.ava-secrets ]]; then
  tar -czf "$BACKUP_DIR/config/platform-secrets.tar.gz" -C /root .ava-secrets
fi

# Stop writers before both logical and physical snapshots. Set the recovery
# flag before the first stop so a partially failed stop still resumes services.
STACK_STOPPED=1
compose stop nginx web_server api_server background indexing_model_server inference_model_server

docker exec onyx-relational_db-1 sh -c \
  'exec pg_dumpall -U "$POSTGRES_USER" --globals-only' \
  > "$BACKUP_DIR/data/postgres-globals.sql"

mapfile -t database_names < <(
  docker exec onyx-relational_db-1 sh -c \
    'exec psql -U "$POSTGRES_USER" -d postgres -Atc \
      "select datname from pg_database where datistemplate=false order by 1"'
)

for database_name in "${database_names[@]}"; do
  if [[ ! "$database_name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    printf 'Unsafe database name: %s\n' "$database_name" >&2
    exit 1
  fi
  dump_name="postgres-${database_name}.dump"
  docker exec onyx-relational_db-1 sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$1" -Fc' sh "$database_name" \
    > "$BACKUP_DIR/data/$dump_name"
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --user 0:0 \
    -v "${BACKUP_DIR}/data:/backup:ro" \
    "$ARCHIVE_IMAGE" pg_restore -l "/backup/${dump_name}" \
    > "$BACKUP_DIR/manifests/${dump_name%.dump}-contents.txt"
done

compose stop opensearch minio relational_db cache

snapshot_volume() {
  local container="$1"
  local destination="$2"
  local archive_name="$3"
  local volume_name

  volume_name="$(docker inspect "$container" --format \
    "{{range .Mounts}}{{if eq .Destination \"${destination}\"}}{{.Name}}{{end}}{{end}}")"
  if [[ -z "$volume_name" ]]; then
    printf 'Missing volume for %s:%s\n' "$container" "$destination" >&2
    return 1
  fi

  printf '%s\t%s\t%s\n' "$archive_name" "$volume_name" "$destination" \
    >> "$BACKUP_DIR/manifests/volumes.tsv"
  docker run --rm --network none --read-only --cap-drop ALL \
    --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true --user 0:0 \
    -v "${volume_name}:/source:ro" -v "${BACKUP_DIR}/data:/backup" \
    "$ARCHIVE_IMAGE" sh -c "cd /source && tar -czf /backup/${archive_name}.tar.gz ."
}

snapshot_volume onyx-relational_db-1 /var/lib/postgresql/data postgres-volume
snapshot_volume onyx-opensearch-1 /usr/share/opensearch/data opensearch-volume
snapshot_volume onyx-minio-1 /data minio-volume
snapshot_volume onyx-api_server-1 /app/file-system file-system-volume

for archive in "$BACKUP_DIR"/data/*.tar.gz; do
  tar -tzf "$archive" >/dev/null
done

compose up -d --wait --wait-timeout 900
STACK_STOPPED=0

find "$BACKUP_DIR" -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sed "s#${BACKUP_DIR}/##" \
  > "$BACKUP_DIR/SHA256SUMS"

(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
printf '%s\n' "$BACKUP_DIR"
