#!/usr/bin/env bash
# Install a verified prepared archive on the new same-OS host, without starting
# AVA/CRM/WhatsApp/Asterisk. The old writer must be stopped before final activation.
set -Eeuo pipefail
umask 077
stamp="${1:?UTC stamp}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
stage="/root/backups/ava/single-host-$stamp/prepare"
release="/root/ava-releases/single-host-$stamp"
test ! -e /root/ava-current
test ! -e "$release"
test ! -e /usr/sbin/asterisk
test ! -e /etc/asterisk
test ! -e /root/xray-client
cd "$stage"
sha256sum --check --status SHA256SUMS
old_redis="$(docker image inspect --format '{{.Id}}' redis:7-alpine)"
docker image load -i images.tar.gz
docker tag redis:7-alpine ava-migrated-redis:20260907
docker tag "$old_redis" redis:7-alpine
mkdir -p /root/ava-releases
mkdir "$release"
cp -a project/. "$release/"
chmod 755 "$release"
ln -s "$release" /root/ava-current
tar -xf native/asterisk.tar -C /
tar -xzf xray-client.tar.gz -C /root
groupadd --system asterisk
useradd --system --gid asterisk --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk
mkdir -p /var/log/asterisk /run/asterisk
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /run/asterisk
chmod 750 /etc/asterisk
find /etc/asterisk -type f -exec chmod 640 {} +
chown -R 1000:asterisk "$release/data" "$release/asterisk_media"
chmod 2775 "$release/data" "$release/asterisk_media"
cp -a /etc/fstab "/root/backups/ava/single-host-$stamp/fstab.before"
python3 - "$release" <<'PY'
from pathlib import Path
import grp,re,runpy,sys
root=Path(sys.argv[1])
update_env=runpy.run_path(str(root/'scripts/configure-platform-bridges.py'))['update_env']
update_env(root/'.env',{'ASTERISK_GID':str(grp.getgrnam('asterisk').gr_gid),
    'DOCKER_GID':str(grp.getgrnam('docker').gr_gid),'HOST_PROJECT_ROOT':'/root/ava-current',
    'AVA_REDIS_IMAGE':'ava-migrated-redis:20260907'})
p=Path('/etc/asterisk/pjsip_custom.conf')
text=p.read_text()
text,count=re.subn(r'(?m)^(external_(?:media|signaling)_address\s*=\s*)83\.136\.235\.18\s*$',r'\g<1>203.0.113.10',text)
assert count==4, f'Unexpected SIP transport count: {count}'
p.write_text(text)
compose=root/'docker-compose.yml'
text=compose.read_text()
assert '    image: redis:7-alpine' in text
compose.write_text(text.replace('    image: redis:7-alpine','    image: ${AVA_REDIS_IMAGE:-redis:7-alpine}'))
fstab=Path('/etc/fstab')
assert '/var/lib/asterisk/sounds/ai-generated' not in fstab.read_text()
with fstab.open('a') as stream:
    stream.write('\n/root/ava-current/asterisk_media/ai-generated /var/lib/asterisk/sounds/ai-generated none bind,nofail,x-systemd.automount 0 0\n')
    stream.write('/root/ava-current/asterisk_media /mnt/asterisk_media none bind,nofail,x-systemd.automount 0 0\n')
print('NAT_addresses=4 updated; local paths and host groups configured')
PY
ldconfig
python3 - <<'PY'
import glob,subprocess
output=subprocess.check_output(['ldd','/usr/sbin/asterisk',*glob.glob('/usr/lib/asterisk/modules/*.so')],text=True)
missing=[line.strip() for line in output.splitlines() if 'not found' in line]
assert not missing, missing
print('asterisk_native_dependencies=all resolved')
PY
asterisk -V
# -V returns before CPU-optimized initialization. Exercise CLI initialization as
# well: connection failure is expected on an inactive target, a signal is not.
if timeout 10 asterisk -rx 'core show version' >/dev/null 2>&1; then
  printf 'Asterisk CLI initialized\n'
else
  status=$?
  if [ "$status" -ge 128 ] || [ "$status" -eq 124 ]; then
    printf 'Asterisk binary is not runnable on target (exit %s); rebuild without BUILD_NATIVE before source freeze\n' "$status" >&2
    exit 1
  fi
fi
systemctl daemon-reload
mkdir -p /mnt/asterisk_media /var/lib/asterisk/sounds/ai-generated "$release/asterisk_media/ai-generated"
mount /var/lib/asterisk/sounds/ai-generated
mount /mnt/asterisk_media
docker compose -f /root/xray-client/docker-compose.yml config --quiet
docker compose -f "$release/docker-compose.yml" config --quiet
printf 'prepared_only: no AVA runtime or SIP registration started\n'
