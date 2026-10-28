#!/usr/bin/env bash
# Upload only encrypted recovery sets using a separate chrooted SFTP identity.
# Verify remote bytes by downloading the ciphertext; no remote shell is needed.
set -Eeuo pipefail
umask 077
source_file="${1:-}"
[[ $source_file =~ ^/root/backups/ava/post-pilot-[0-9]{8}T[0-9]{6}Z/recovery-full\.tar\.gz\.gpg$ ]]
[[ -f $source_file && ! -L $source_file ]]
base=/root/backups/ava
[[ -s $base/.offsite-key && -s $base/.offsite-known-hosts ]]
stamp="$(basename "$(dirname "$source_file")")"
remote="/uploads/$stamp.gpg"
verify="$(mktemp "$base/.offsite-verify.XXXXXX")"
trap 'rm -f -- "$verify"' EXIT
sftp -b - -i "$base/.offsite-key" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$base/.offsite-known-hosts" -o ConnectTimeout=15 \
  ava_backup@88.218.122.40 <<EOF
put $source_file $remote.partial
rename $remote.partial $remote
get $remote $verify
EOF
local_sha="$(sha256sum "$source_file" | cut -d' ' -f1)"
remote_sha="$(sha256sum "$verify" | cut -d' ' -f1)"
[[ $local_sha == "$remote_sha" ]]
printf 'offsite_sha256=%s verified_readback=true remote=%s\n' "$remote_sha" "$remote"
