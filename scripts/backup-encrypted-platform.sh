#!/usr/bin/env bash
# Server-side encryption with a public recipient only. The private key stays
# off-host; SSH interruption does not truncate the recovery set.
set -Eeuo pipefail
umask 077
[[ ${1:-} == --run ]] || { echo 'Explicit --run required' >&2; exit 2; }
base=/root/backups/ava
recipient_file="$base/recovery-public.asc"
fingerprint_file="$base/recovery-recipient.txt"
[[ -s $recipient_file && -s $fingerprint_file ]]
recipient="$(tr -d '\r\n' < "$fingerprint_file")"
[[ $recipient =~ ^[A-F0-9]{40,64}$ ]]
keyring="$base/.recipient-public-keyring"
mkdir -p "$keyring"; chmod 700 "$keyring"
gpg --homedir "$keyring" --batch --import "$recipient_file" >/dev/null 2>&1
gpg --homedir "$keyring" --batch --with-colons --list-keys "$recipient" |
  awk -F: -v expected="$recipient" '$1=="fpr" && $10==expected {found=1} END{exit !found}'
# This host must never acquire the corresponding private key.
[[ -z $(gpg --homedir "$keyring" --batch --with-colons --list-secret-keys 2>/dev/null) ]]
destination="$base/post-pilot-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$destination"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/backup-unified-platform.sh" --stream-consistent |
  gpg --homedir "$keyring" --batch --trust-model always --cipher-algo AES256 \
    --encrypt --recipient "$recipient" --output "$destination/recovery-full.tar.gz.gpg.partial"
mv "$destination/recovery-full.tar.gz.gpg.partial" "$destination/recovery-full.tar.gz.gpg"
(cd "$destination" && sha256sum recovery-full.tar.gz.gpg > SHA256SUMS)
printf '%s\n' "$destination"
