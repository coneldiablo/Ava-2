#!/usr/bin/env sh
set -eu

BACKUP="${1:-}"
COMPOSE_FILE="${CRM_COMPOSE_FILE:-docker-compose.yml}"
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
    echo "Usage: $0 /path/to/profile.db" >&2
    exit 1
fi

docker compose -f "$COMPOSE_FILE" stop app
docker compose -f "$COMPOSE_FILE" run --rm --no-deps -T app sh -c '
    rm -f /app/data/crm_v2.db /app/data/crm_v2.db-wal /app/data/crm_v2.db-shm
    cat > /app/data/crm_v2.db
' < "$BACKUP"
docker compose -f "$COMPOSE_FILE" up -d app

echo "Profile restored from: $BACKUP"
