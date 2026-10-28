#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# ONYX RESTORE SCRIPT (Stage 1: Backup & Disaster Recovery)
# Restores an Onyx snapshot from backup and triggers re-indexing.
# ==============================================================================

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <path_to_backup_directory>"
    echo "Example: $0 /tmp/onyx_backups/onyx_backup_20260831_023000"
    exit 1
fi

BACKUP_PATH="$1"
CONTAINER_DB="${CONTAINER_DB:-onyx-staging-db}"
POSTGRES_USER="${POSTGRES_USER:-onyx_user}"
POSTGRES_DB="${POSTGRES_DB:-onyx_db}"

if [ ! -d "${BACKUP_PATH}" ]; then
    echo "[ERROR] Backup directory not found: ${BACKUP_PATH}"
    exit 1
fi

echo "=================================================="
echo " Starting Onyx Restore from: ${BACKUP_PATH}"
echo "=================================================="

# 1. Verify Checksums
if [ -f "${BACKUP_PATH}/checksums.sha256" ]; then
    echo "[1/3] Verifying checksums..."
    cd "${BACKUP_PATH}"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 -c checksums.sha256
    else
        sha256sum -c checksums.sha256
    fi
    echo "  -> Checksums verified."
fi

# 2. Restore PostgreSQL
echo "[2/3] Restoring PostgreSQL database..."
if [ -f "${BACKUP_PATH}/onyx_db.sql" ]; then
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_DB}$"; then
        docker exec -i "${CONTAINER_DB}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${BACKUP_PATH}/onyx_db.sql"
        echo "  -> PostgreSQL database restored."
    else
        echo "  [WARNING] Container ${CONTAINER_DB} not running. Skipped live SQL injection."
    fi
fi

# 3. Trigger Re-indexing / Verification
echo "[3/3] Re-indexing instructions:"
echo "  To trigger a full re-index after restore, run:"
echo "  curl -X POST http://localhost:8080/api/manage/admin/reindex-all"

echo "=================================================="
echo " Restore Procedure Completed!"
echo "=================================================="
