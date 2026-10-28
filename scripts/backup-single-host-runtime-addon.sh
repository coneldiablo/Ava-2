#!/usr/bin/env bash
# Additive runtime recovery checkpoint; requires the verified prepare/final set.
# Pauses the one selected session, snapshots it, then restores it immediately.
# Intended for this single-active-business migration, not a multi-session host.
# The caller encrypts the resulting archive with a key streamed from the Mac.
set -Eeuo pipefail
umask 077
stamp="${1:?UTC stamp}"
business_id="${2:?business id}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$business_id" =~ ^[1-9][0-9]*$ ]]
root=/root/ava-current
base=/root/backups/ava/single-host-20260907T100000Z
target="$base/runtime-$stamp"
test ! -e "$target"
mkdir -p "$target/sqlite" "$target/openwa-data"
stage="$target"
paused=0
resume_session() {
  if [[ "$paused" == 1 ]]; then
    docker exec -i -w /app whatsapp_crm node - "$business_id" <<'JS'
const DB=require('./src/services/database.service');
DB.db=new(require('better-sqlite3'))('/app/data/crm_v2.db');
require('./src/services/whatsapp-connection.service').connect(Number(process.argv[2]))
  .then(r=>{console.log(JSON.stringify({session_resumed:r.success,type:r.type}));if(!r.success)process.exitCode=1;DB.db.close()})
  .catch(()=>{console.error('session_resume_failed');process.exitCode=1});
JS
    paused=0
  fi
}
trap resume_session EXIT
tar -C "$root" --exclude='*/__pycache__' --exclude='*/node_modules' -czf "$stage/source.tar.gz" \
  .env docker-compose.yml config secrets src admin_ui/backend whatsapp_crm/src \
  whatsapp_crm/frontend/dist deploy scripts docs
tar -C / -czf "$stage/native-and-system.tar.gz" usr/sbin/asterisk usr/lib/asterisk \
  usr/lib/libasteriskpj.so usr/lib/libasteriskpj.so.2 usr/lib/libasteriskssl.so \
  usr/lib/libasteriskssl.so.1 etc/asterisk var/lib/asterisk var/spool/asterisk \
  etc/systemd/system etc/nginx etc/ufw etc/fail2ban etc/ssh etc/letsencrypt root/xray-client
openwa=/var/lib/docker/volumes/asterisk-ai-voice-agent_whatsapp_crm_openwa_data/_data
paused=1
docker exec -i -w /app whatsapp_crm node - "$business_id" <<'JS'
const DB=require('./src/services/database.service');
DB.db=new(require('better-sqlite3'))('/app/data/crm_v2.db');
const G=require('./src/services/openwa.service');
(async()=>{const i=await DB.getInstance(Number(process.argv[2]));if(!i?.openWaSessionId)throw Error('missing_session');
const r=await G.stopSession(i.openWaUrl,i.openWaApiKey,i.openWaSessionId);if(!r.success)throw Error('stop_failed');
console.log('session_paused_for_snapshot');DB.db.close()})().catch(()=>{console.error('session_pause_failed');process.exitCode=1});
JS
# Browser profile is copied only after the session is stopped; SQLite itself
# is captured via the online backup API, including WAL data.
tar -C "$openwa" --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' -cf - . |
  tar -C "$stage/openwa-data" -xf -
python3 - "$root" "$stage" "$openwa" <<'PY'
import pathlib, sqlite3, sys
root, stage, openwa = map(pathlib.Path, sys.argv[1:])
sources = [(root/'data/whatsapp_crm/crm_v2.db',stage/'sqlite/crm_v2.db'),
           (root/'data/call_history.db',stage/'sqlite/call_history.db')]
sources += [(p,stage/'openwa-data'/p.name) for p in openwa.glob('*.sqlite')]
for source, destination in sources:
    with sqlite3.connect(f'file:{source}?mode=ro',uri=True) as live, sqlite3.connect(destination) as snapshot:
        live.backup(snapshot)
        assert snapshot.execute('PRAGMA quick_check').fetchone()[0]=='ok', source.name
print(f'sqlite_snapshots={len(sources)} quick_check=ok')
PY
resume_session
docker inspect --format '{{.Name}}|{{.Image}}|{{.Config.Image}}' \
  ai_engine admin_ui whatsapp_crm whatsapp_crm_openwa > "$stage/running-images.txt"
docker image save asterisk-ai-voice-agent-whatsapp-crm:whatsapp-replacement-20260907 |
  gzip -1 > "$stage/crm-image.tar.gz"
docker compose -f "$root/docker-compose.yml" config --quiet
nginx -t
sha256sum /usr/sbin/asterisk > "$stage/asterisk.sha256"
cd "$stage"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
tar -C "$base" -czf "$target.tar.gz" "$(basename "$target")"
printf '%s\n' "$target.tar.gz"
