#!/usr/bin/env bash
# Scoped pre-switch recovery set. Stream stdout directly into encryption on Mac.
# No service stop, no production restore, and no plaintext output in tool logs.
set -Eeuo pipefail
umask 077
stage="$(mktemp -d /tmp/ava-crm-workspace-backup.XXXXXX)"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/twenty" "$stage/sqlite" "$stage/ava"
cp -a /etc/nginx "$stage/nginx"
cp -a /etc/letsencrypt "$stage/letsencrypt"
cp /opt/ava-deploy/twenty/.env /opt/ava-deploy/twenty/docker-compose.twenty.yml \
  /opt/ava-deploy/twenty/docker-compose.production.yml "$stage/twenty/"
if [[ -f /opt/ava-deploy/twenty/docker-compose.workspaces.yml ]]; then
  cp /opt/ava-deploy/twenty/docker-compose.workspaces.yml "$stage/twenty/"
fi
cp /root/ava-current/.env "$stage/ava/"
docker exec ava-twenty-db-1 pg_dump -U twenty -d twenty -Fc > "$stage/twenty/database.pgdump"
python3 - "$stage/sqlite/crm_v2.db" <<'PY'
import sqlite3,sys
source='/root/ava-current/data/whatsapp_crm/crm_v2.db'
with sqlite3.connect(f'file:{source}?mode=ro',uri=True) as live, sqlite3.connect(sys.argv[1]) as snapshot:
    live.backup(snapshot)
    assert snapshot.execute('PRAGMA quick_check').fetchone()[0]=='ok'
PY
docker inspect --format '{{.Name}} {{.Image}} {{.Config.Image}}' \
  ava-twenty-server-1 ava-twenty-worker-1 ava-twenty-db-1 whatsapp_crm > "$stage/images.txt"
(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar -C "$stage" -czf - .
