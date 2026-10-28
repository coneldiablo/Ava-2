#!/usr/bin/env sh
set -eu

DESTINATION="${1:-backups/accent-coffee-profile-$(date +%Y%m%d-%H%M%S).db}"
CONTAINER="${CRM_CONTAINER_NAME:-whats_koord_app}"
CONTAINER_BACKUP="/tmp/crm-profile-backup.db"

mkdir -p "$(dirname "$DESTINATION")"

docker exec "$CONTAINER" node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/app/data/crm_v2.db');
db.backup('$CONTAINER_BACKUP')
  .then(() => db.close())
  .catch(error => { console.error(error); process.exit(1); });
"

docker cp "$CONTAINER:$CONTAINER_BACKUP" "$DESTINATION"
docker exec "$CONTAINER" rm -f "$CONTAINER_BACKUP"

echo "Profile backup created: $DESTINATION"
