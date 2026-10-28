#!/usr/bin/env bash
set -euo pipefail

# Consistent, encrypted AVA recovery backup. This script never restores data.
# Usage: BACKUP_PASSPHRASE_FILE=/root/.secrets/ava-backup.pass ./scripts/backup-production-recovery.sh [daily|weekly|pre-bnovo|pre-deploy]

KIND="${1:-daily}"
case "$KIND" in
  daily|weekly|pre-bnovo|pre-deploy) ;;
  *) echo "kind must be daily, weekly, pre-bnovo, or pre-deploy" >&2; exit 2 ;;
esac

PROJECT_DIR="${AVA_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_ROOT="${AVA_BACKUP_ROOT:-/root/backups/ava}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE is required}"
CRM_DB="${DB_PATH:-$PROJECT_DIR/data/whatsapp_crm/crm_v2.db}"
CALL_DB="${CALL_HISTORY_DB_PATH:-$PROJECT_DIR/data/call_history.db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${KIND}-${STAMP}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ava-backup.XXXXXX")"
STAGE="$WORK/stage"
PLAIN="$WORK/${NAME}.tar.gz"
if [[ "$KIND" == pre-bnovo || "$KIND" == pre-deploy ]]; then
  FINAL_DIR="$BACKUP_ROOT/$NAME"
  FINAL="$FINAL_DIR/recovery.tar.gz.gpg"
else
  FINAL_DIR="$BACKUP_ROOT/$KIND"
  FINAL="$FINAL_DIR/${NAME}.tar.gz.gpg"
fi

cleanup() {
  if [[ -f "$PLAIN" ]]; then shred -u "$PLAIN" 2>/dev/null || unlink "$PLAIN"; fi
  find "$WORK" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

test -r "$PASSPHRASE_FILE"
test "$(stat -c '%a' "$PASSPHRASE_FILE" 2>/dev/null || stat -f '%Lp' "$PASSPHRASE_FILE")" = "600"
mkdir -p "$STAGE/sqlite" "$STAGE/project/source-tree" "$STAGE/system" "$FINAL_DIR"
chmod 700 "$WORK" "$FINAL_DIR"

sqlite3 "$CRM_DB" ".timeout 30000" ".backup '$STAGE/sqlite/crm_v2.db'"
sqlite3 "$CALL_DB" ".timeout 30000" ".backup '$STAGE/sqlite/call_history.db'"
sqlite3 "$STAGE/sqlite/crm_v2.db" 'PRAGMA quick_check;' > "$STAGE/sqlite/crm_v2.quick_check.txt"
sqlite3 "$STAGE/sqlite/call_history.db" 'PRAGMA quick_check;' > "$STAGE/sqlite/call_history.quick_check.txt"
grep -qx ok "$STAGE/sqlite/crm_v2.quick_check.txt"
grep -qx ok "$STAGE/sqlite/call_history.quick_check.txt"

for item in .env config secrets data/RAG data/rag rag_data; do
  if [[ -e "$PROJECT_DIR/$item" ]]; then cp -a "$PROJECT_DIR/$item" "$STAGE/project/"; fi
done
if [[ -f "$PROJECT_DIR/whatsapp_crm/.env" ]]; then
  mkdir -p "$STAGE/project/whatsapp_crm"
  cp -a "$PROJECT_DIR/whatsapp_crm/.env" "$STAGE/project/whatsapp_crm/.env"
fi
if [[ -d /etc/asterisk ]]; then cp -a /etc/asterisk "$STAGE/system/asterisk"; fi
for item in /etc/caddy /etc/nginx /etc/systemd/system; do
  if [[ -e "$item" ]]; then cp -a "$item" "$STAGE/system/"; fi
done

if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" rev-parse HEAD > "$STAGE/project/git-head.txt"
  git -C "$PROJECT_DIR" status --short > "$STAGE/project/git-status.txt"
  git -C "$PROJECT_DIR" diff --binary > "$STAGE/project/live-working-tree.patch"
  git -C "$PROJECT_DIR" bundle create "$STAGE/project/repository.bundle" --all
else
  printf '%s\n' "${AVA_RELEASE_COMMIT:-unknown}" > "$STAGE/project/git-head.txt"
  printf '%s\n' "release source tree is not attached to a usable Git worktree" > "$STAGE/project/git-status.txt"
  : > "$STAGE/project/live-working-tree.patch"
  printf '%s\n' "not available; exact source tree is included in project/source-tree" \
    > "$STAGE/project/repository.bundle.unavailable.txt"
fi

# Preserve the exact live source tree as well as Git metadata. This captures
# untracked production hotfix files without duplicating databases, secrets,
# dependencies, models, recordings, or generated caches.
tar -C "$PROJECT_DIR" \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./data' \
  --exclude='./secrets' \
  --exclude='./models' \
  --exclude='./asterisk_media' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./.venv*' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  -cf - . | tar -C "$STAGE/project/source-tree" -xf -

docker compose -f "$PROJECT_DIR/docker-compose.yml" config --quiet
docker compose -f "$PROJECT_DIR/docker-compose.yml" config > "$STAGE/project/compose-resolved.yml"
docker image ls --no-trunc --digests > "$STAGE/project/docker-images.txt"
mapfile -t COMPOSE_CONTAINERS < <(docker compose -f "$PROJECT_DIR/docker-compose.yml" ps -q)
if ((${#COMPOSE_CONTAINERS[@]})); then
  docker inspect "${COMPOSE_CONTAINERS[@]}" > "$STAGE/project/docker-containers.json"
else
  printf '[]\n' > "$STAGE/project/docker-containers.json"
fi
findmnt -J > "$STAGE/system/mounts.json"

{
  echo "created_utc=$STAMP"
  echo "kind=$KIND"
  echo "project_dir=$PROJECT_DIR"
  echo "git_head=$(cat "$STAGE/project/git-head.txt")"
  echo "crm_quick_check=$(cat "$STAGE/sqlite/crm_v2.quick_check.txt")"
  echo "call_quick_check=$(cat "$STAGE/sqlite/call_history.quick_check.txt")"
} > "$STAGE/manifest.txt"

tar -C "$STAGE" -czf "$PLAIN" .
gpg --batch --yes --pinentry-mode loopback --cipher-algo AES256 \
  --passphrase-file "$PASSPHRASE_FILE" --symmetric --output "$FINAL" "$PLAIN"
chmod 600 "$FINAL"
sha256sum "$FINAL" > "$FINAL.sha256"
chmod 600 "$FINAL.sha256"

# Prove the encrypted archive can be decrypted and its database snapshots can
# be opened. Nothing from this verification is written back to production.
RESTORE="$WORK/restore-check"
mkdir -p "$RESTORE"
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" --decrypt "$FINAL" | tar -xzf - -C "$RESTORE"
test -s "$RESTORE/manifest.txt"
if [[ -f "$RESTORE/project/repository.bundle" ]]; then
  test -s "$RESTORE/project/repository.bundle"
else
  test -s "$RESTORE/project/repository.bundle.unavailable.txt"
fi
test -f "$RESTORE/project/live-working-tree.patch"
test -d "$RESTORE/project/source-tree"
test "$(sqlite3 "$RESTORE/sqlite/crm_v2.db" 'PRAGMA quick_check;')" = ok
test "$(sqlite3 "$RESTORE/sqlite/call_history.db" 'PRAGMA quick_check;')" = ok
if [[ -f "$RESTORE/project/.env" ]]; then
  cp "$RESTORE/project/.env" "$RESTORE/project/source-tree/.env"
  docker compose \
    --env-file "$RESTORE/project/.env" \
    -f "$RESTORE/project/source-tree/docker-compose.yml" \
    config --quiet
else
  docker compose \
    -f "$RESTORE/project/source-tree/docker-compose.yml" \
    config --quiet
fi

if [[ "$KIND" != pre-bnovo && "$KIND" != pre-deploy ]]; then
  KEEP=7; [[ "$KIND" == weekly ]] && KEEP=4
  mapfile -t OLD < <(find "$FINAL_DIR" -maxdepth 1 -type f -name "${KIND}-*.tar.gz.gpg" -printf '%T@ %p\n' | sort -nr | tail -n "+$((KEEP + 1))" | cut -d' ' -f2-)
  for archive in "${OLD[@]:-}"; do
    [[ -n "$archive" ]] || continue
    shred -u "$archive" 2>/dev/null || unlink "$archive"
    [[ -f "$archive.sha256" ]] && unlink "$archive.sha256"
  done
fi

echo "$FINAL"
