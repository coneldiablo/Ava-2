#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
test -f .env || { echo "Missing $ROOT/.env" >&2; exit 1; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${TWENTY_BACKUP_DIR:-/root/backups/ava/twenty}/$timestamp"
mkdir -p "$target"

docker compose --env-file .env -f docker-compose.twenty.yml exec -T db \
  sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$target/twenty.pgdump"
docker run --rm -v ava-twenty_server-local-data:/data:ro -v "$target:/backup" alpine:3.22 \
  tar -C /data -czf /backup/server-local-data.tgz .
docker run --rm -v ava-twenty_redis-data:/data:ro -v "$target:/backup" alpine:3.22 \
  tar -C /data -czf /backup/redis-data.tgz .
cp .env "$target/env.recovery"
cp docker-compose.twenty.yml schema-manifest.json "$target/"
(cd "$target" && sha256sum * > SHA256SUMS)

find "$(dirname "$target")" -mindepth 1 -maxdepth 1 -type d -mtime +28 -exec rm -rf -- {} +
echo "$target"
