#!/usr/bin/env bash
# Prepare an exact AVA runtime for a same-OS/architecture host move.
# Does not stop services, register SIP, or alter the live installation.
# Encrypt the private result immediately; never commit any output to Git.
set -Eeuo pipefail
umask 077
stamp="${1:?UTC stamp}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
root=/root/ava-current
target="/root/backups/ava/single-host-$stamp"
test ! -e "$target"
mkdir -p "$target/prepare/project" "$target/prepare/native" "$target/prepare/sqlite"
stage="$target/prepare"
tar -C "$root" --dereference --exclude='./.git' --exclude='./data' \
  --exclude='./models' --exclude='./asterisk_media' --exclude='*/__pycache__' \
  --exclude='*/node_modules' --exclude='./.venv*' -cf - . | tar -C "$stage/project" -xf -
for item in data models asterisk_media; do
  mkdir -p "$stage/project/$item"
  tar -C "$(readlink -f "$root/$item")" --exclude='*-wal' --exclude='*-shm' \
    --exclude='./call_history.db' --exclude='./whatsapp_crm/crm_v2.db' -cf - . |
    tar -C "$stage/project/$item" -xf -
done
python3 - "$root" "$stage" <<'PY'
import pathlib,sqlite3,sys
root,stage=map(pathlib.Path,sys.argv[1:])
for relative in ('data/whatsapp_crm/crm_v2.db','data/call_history.db'):
    destination=stage/'project'/relative
    destination.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(f'file:{root/relative}?mode=ro',uri=True) as live,sqlite3.connect(destination) as backup:
        live.backup(backup)
        assert backup.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('sqlite_online_snapshots=2 checked')
PY
tar -C / -cf "$stage/native/asterisk.tar" usr/sbin/asterisk usr/lib/asterisk \
  usr/lib/libasteriskpj.so usr/lib/libasteriskpj.so.2 usr/lib/libasteriskssl.so \
  usr/lib/libasteriskssl.so.1 etc/asterisk var/lib/asterisk var/spool/asterisk \
  etc/systemd/system/asterisk.service
tar -C /root -czf "$stage/xray-client.tar.gz" xray-client
tar -C / -czf "$stage/old-system-config.tar.gz" etc/caddy etc/fail2ban etc/ufw etc/systemd/system
images=(asterisk-ai-voice-agent-ai-engine:latest asterisk-ai-voice-agent-admin-ui:latest
  asterisk-ai-voice-agent-whatsapp-crm:latest asterisk-ai-voice-agent-openwa:0.23.4
  asterisk-ai-voice-agent-whatsapp-crm-telegram-proxy:latest teddysun/xray:latest redis:7-alpine)
docker inspect --format '{{.Name}}|{{.Image}}|{{.Config.Image}}' ai_engine admin_ui \
  whatsapp_crm whatsapp_crm_openwa whatsapp_crm_redis whatsapp_crm_telegram_proxy xray-client > "$stage/running-images.txt"
docker image save "${images[@]}" | gzip -1 > "$stage/images.tar.gz"
docker compose -f "$root/docker-compose.yml" config --quiet
dpkg-query -W > "$stage/source-packages.txt"
id asterisk > "$stage/source-asterisk-user.txt"
cd "$stage"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum --check --status SHA256SUMS
tar -C "$target" -cf "$target/prepare.tar" prepare
printf '%s\n' "$target/prepare.tar"
