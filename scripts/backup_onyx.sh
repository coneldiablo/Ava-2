#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ONYX_ROOT="${ONYX_ROOT:-/opt/onyx-v4.7.0}"
COMPOSE_DIR="${ONYX_ROOT}/deployment/docker_compose"
COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.prod-no-letsencrypt.yml"
BACKUP_ROOT="${BACKUP_ROOT:-/root/backups/ava/onyx}"
PASSPHRASE_FILE="${AVA_BACKUP_PASSPHRASE_FILE:?set AVA_BACKUP_PASSPHRASE_FILE}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-onyx}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d)"
ARCHIVE="${BACKUP_ROOT}/onyx-${TIMESTAMP}.tar.gz.gpg"
PAUSED=0

cleanup() {
  if [[ "$PAUSED" == "1" ]]; then
    docker compose --env-file "${COMPOSE_DIR}/.env" -f "$COMPOSE_FILE" unpause api_server background >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

[[ -f "$COMPOSE_FILE" ]] || { echo "Missing reviewed Onyx compose: $COMPOSE_FILE" >&2; exit 1; }
[[ -f "${COMPOSE_DIR}/.env" ]] || { echo "Missing ${COMPOSE_DIR}/.env" >&2; exit 1; }
[[ -f "${COMPOSE_DIR}/.env.nginx" ]] || { echo "Missing ${COMPOSE_DIR}/.env.nginx" >&2; exit 1; }
[[ -f "$PASSPHRASE_FILE" ]] || { echo "Backup passphrase file not found" >&2; exit 1; }
[[ "$(stat -c '%a' "$PASSPHRASE_FILE" 2>/dev/null || stat -f '%Lp' "$PASSPHRASE_FILE")" == "600" ]] || {
  echo "Backup passphrase file must have mode 0600" >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
. "${COMPOSE_DIR}/.env"
set +a

mkdir -p "$BACKUP_ROOT"
RUNNING_SERVICES="$(docker compose --env-file "${COMPOSE_DIR}/.env" -f "$COMPOSE_FILE" ps --services --status running)"
for service in api_server background relational_db minio; do
  grep -qx "$service" <<<"$RUNNING_SERVICES" || { echo "Onyx service is not running: $service" >&2; exit 1; }
done

# Quiesce Onyx writers; the database and MinIO remain available for consistent reads.
docker compose --env-file "${COMPOSE_DIR}/.env" -f "$COMPOSE_FILE" pause api_server background >/dev/null
PAUSED=1

docker compose --env-file "${COMPOSE_DIR}/.env" -f "$COMPOSE_FILE" exec -T relational_db \
  pg_dump -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" \
  --format=custom --no-owner --no-acl > "${WORK_DIR}/onyx-postgres.dump"

MINIO_VOLUME="${PROJECT_NAME}_minio_data"
docker volume inspect "$MINIO_VOLUME" >/dev/null
docker run --rm -v "${MINIO_VOLUME}:/source:ro" -v "${WORK_DIR}:/backup" alpine:3.22 \
  tar -C /source -czf /backup/onyx-minio.tar.gz .

cp "${COMPOSE_DIR}/.env" "${WORK_DIR}/onyx.env"
cp "${COMPOSE_DIR}/.env.nginx" "${WORK_DIR}/onyx.env.nginx"
cp "$COMPOSE_FILE" "${WORK_DIR}/docker-compose.yml"
git -C "$ONYX_ROOT" rev-parse HEAD > "${WORK_DIR}/onyx.commit"

cat > "${WORK_DIR}/manifest.json" <<EOF
{"created_at":"${TIMESTAMP}","onyx_version":"v4.7.0","commit":"$(cat "${WORK_DIR}/onyx.commit")","database_format":"pg_dump_custom","search_index":"rebuild_from_postgres_and_minio"}
EOF

(cd "$WORK_DIR" && sha256sum onyx-postgres.dump onyx-minio.tar.gz onyx.env onyx.env.nginx docker-compose.yml onyx.commit manifest.json > SHA256SUMS)

tar -C "$WORK_DIR" -czf - . | gpg --batch --yes --symmetric --cipher-algo AES256 \
  --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" --output "$ARCHIVE"
sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"
gpg --batch --decrypt --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" "$ARCHIVE" \
  2>/dev/null | tar -tzf - >/dev/null

docker compose --env-file "${COMPOSE_DIR}/.env" -f "$COMPOSE_FILE" unpause api_server background >/dev/null
PAUSED=0

find "$BACKUP_ROOT" -type f -name 'onyx-*.tar.gz.gpg' -mtime +28 -delete
find "$BACKUP_ROOT" -type f -name 'onyx-*.tar.gz.gpg.sha256' -mtime +28 -delete

echo "Encrypted Onyx backup verified: $ARCHIVE"
