#!/usr/bin/env bash
# Additive phase checkpoint. Use with the verified full platform recovery set.
# Caller encrypts the resulting archive with a key streamed from the Mac.
set -Eeuo pipefail
umask 077
role="${1:?phone or onyx}"
phase="${2:?before or after}"
stamp="${3:?UTC deployment stamp}"
[[ "$role" =~ ^(phone|onyx)$ && "$phase" =~ ^(before|after)$ && "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
target="/root/backups/ava/onyx-mcp-$stamp/$phase"
[[ ! -e "$target" ]]
mkdir -p "$target"
if [[ "$role" == phone ]]; then
  cd /root/ava-current
  tar -czf "$target/source.tar.gz" .env docker-compose.yml admin_ui/backend src/core deploy/admin \
    scripts/provision-onyx-*.py whatsapp_crm/src deploy/crm
  python3 - "$target" <<'PY'
import pathlib, sqlite3, sys
target = pathlib.Path(sys.argv[1])
for source, name in [('/root/ava-current/data/whatsapp_crm/crm_v2.db','crm_v2.db'),
                     ('/root/ava-current/data/call_history.db','call_history.db')]:
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as live, sqlite3.connect(target/name) as snapshot:
        live.backup(snapshot)
        assert snapshot.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
print('sqlite_snapshots=2 quick_check=ok')
PY
  docker inspect --format '{{.Name}}|{{.Image}}' admin_ui ai_engine whatsapp_crm > "$target/images.txt"
else
  cd /opt/onyx-v4.7.0/deployment/docker_compose
  tar -czf "$target/config.tar.gz" .env .env.nginx docker-compose.prod-no-letsencrypt.yml docker-compose.ava-production.yml
  docker exec onyx-relational_db-1 pg_dump -U onyx -d postgres -Fc > "$target/onyx.dump"
  docker exec onyx-relational_db-1 pg_dumpall -U onyx --globals-only > "$target/globals.sql"
  docker exec -i onyx-relational_db-1 pg_restore -l < "$target/onyx.dump" > "$target/restore-list.txt"
  docker inspect --format '{{.Name}}|{{.Image}}' onyx-api_server-1 onyx-background-1 onyx-relational_db-1 > "$target/images.txt"
fi
cd "$target"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
printf '%s checkpoint verified\n' "$role/$phase"
