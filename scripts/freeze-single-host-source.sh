#!/usr/bin/env bash
# Cutover-only: stop all old AVA writers, then export a consistent final state.
# Requires a fully prepared target; never starts a second SIP registration.
set -Eeuo pipefail
umask 077
stamp="${1:?UTC stamp}"
test "${2:-}" = TARGET_PREPARED
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
ip -4 address show | grep -q '83.136.235.18/'
target="/root/backups/ava/single-host-$stamp"
test -s "$target/prepare.tar.gpg"
test ! -e "$target/final"
asterisk -rx 'core show channels count' | grep -qx '0 active calls'
mkdir -p "$target/final/project/data" "$target/final/project/asterisk_media" "$target/final/volumes"
docker inspect --format '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}' \
  ai_engine admin_ui whatsapp_crm whatsapp_crm_openwa whatsapp_crm_redis \
  whatsapp_crm_telegram_proxy xray-client > "$target/final/old-restart-policies.txt"
docker update --restart=no ai_engine admin_ui whatsapp_crm whatsapp_crm_openwa \
  whatsapp_crm_redis whatsapp_crm_telegram_proxy xray-client >/dev/null
# Drain channel ingress while CRM is still present, then stop DB writers.
docker stop --time 45 whatsapp_crm_openwa >/dev/null
docker stop --time 30 ai_engine >/dev/null
asterisk -rx 'core show channels count' | grep -qx '0 active calls'
systemctl stop asterisk
systemctl disable asterisk
docker stop --time 30 admin_ui whatsapp_crm whatsapp_crm_telegram_proxy whatsapp_crm_redis xray-client >/dev/null
for name in ai_engine admin_ui whatsapp_crm whatsapp_crm_openwa whatsapp_crm_redis whatsapp_crm_telegram_proxy xray-client; do
  test "$(docker inspect --format '{{.State.Running}}' "$name")" = false
done
! systemctl is-active --quiet asterisk
for item in data asterisk_media; do
  tar -C "$(readlink -f "/root/ava-current/$item")" --exclude='*-wal' --exclude='*-shm' \
    --exclude='./call_history.db' --exclude='./whatsapp_crm/crm_v2.db' -cf - . |
    tar -C "$target/final/project/$item" -xf -
done
python3 - "$target/final" <<'PY'
from pathlib import Path
import sqlite3,sys
target=Path(sys.argv[1])
for name in ('data/call_history.db','data/whatsapp_crm/crm_v2.db'):
    with sqlite3.connect(f'file:/root/ava-current/{name}?mode=ro',uri=True) as source,sqlite3.connect(target/'project'/name) as destination:
        source.backup(destination)
        assert destination.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('final_sqlite_snapshots=2 quick_check=ok')
PY
for name in whatsapp_crm_openwa_data whatsapp_crm_redis_data whatsapp_crm_telegram_proxy_data; do
  volume="$(docker volume inspect --format '{{.Mountpoint}}' "asterisk-ai-voice-agent_$name")"
  tar -C "$volume" -czf "$target/final/volumes/$name.tar.gz" .
done
tar -C / -czf "$target/final/asterisk-state.tar.gz" var/lib/asterisk var/spool/asterisk
cd "$target/final"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
tar -C "$target" -czf "$target/final.tar.gz" final
printf 'old_runtime_stopped; final_state=%s\n' "$target/final.tar.gz"
