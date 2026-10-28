#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)"
INSTANCE_NAME="RAG Shell Smoke ${RUN_ID}"
TMP_DIR="$(mktemp -d)"
INSTANCE_ID=""

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

json_get() {
    local expr="$1"
    python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)"
}

post_json() {
    local path="$1"
    local body="$2"
    curl -sS -X POST "${BASE_URL}/api${path}" \
        -H "Content-Type: application/json" \
        -d "$body"
}

upload_and_wait() {
    local field_name="$1"
    local file_path="$2"
    local upload_name="$3"

    local response
    response="$(curl -sS -X POST "${BASE_URL}/api/knowledge-base/${INSTANCE_ID}/upload" \
        -F "${field_name}=@${file_path};type=text/plain;filename=${upload_name}")"

    echo "$response" | python3 -m json.tool

    local queued
    queued="$(echo "$response" | json_get "json.dumps((data.get('results') or [{}])[0].get('queued', False))")"
    if [ "$queued" = "true" ]; then
        local job_id
        job_id="$(echo "$response" | json_get "json.dumps(str((data.get('results') or [{}])[0]['jobId']))")"
        job_id="${job_id%\"}"
        job_id="${job_id#\"}"
        echo "Polling queued upload job ${job_id}..."

        for _ in $(seq 1 30); do
            local status
            status="$(curl -sS "${BASE_URL}/api/knowledge-base/${INSTANCE_ID}/upload-status/${job_id}")"
            echo "$status" | python3 -m json.tool

            local state
            state="$(echo "$status" | json_get "json.dumps(data.get('state'))")"
            state="${state%\"}"
            state="${state#\"}"

            if [ "$state" = "completed" ]; then
                local success
                success="$(echo "$status" | json_get "json.dumps(bool((data.get('result') or {}).get('success')))")"
                [ "$success" = "true" ] || { echo "Queued upload completed without success"; exit 1; }
                return 0
            fi

            if [ "$state" = "failed" ]; then
                echo "Queued upload failed"
                exit 1
            fi

            sleep 1
        done

        echo "Queued upload did not finish in time"
        exit 1
    fi
}

echo "========================================="
echo "RAG Shell Smoke Test"
echo "========================================="

echo "1. Health check"
curl -sS "${BASE_URL}/api/health" | python3 -m json.tool

echo "2. Create test instance"
INSTANCE_RESPONSE="$(post_json "/instances" "{\"name\":\"${INSTANCE_NAME}\"}")"
echo "$INSTANCE_RESPONSE" | python3 -m json.tool
INSTANCE_ID="$(echo "$INSTANCE_RESPONSE" | json_get "json.dumps(data['instance']['id'])")"
INSTANCE_ID="${INSTANCE_ID%\"}"
INSTANCE_ID="${INSTANCE_ID#\"}"

cat > "${TMP_DIR}/smoke-rag-v1.txt" <<EOF
Смоук-тест RAG ${RUN_ID}
Женская стрижка стоит 2500 рублей.
Мужская стрижка стоит 1800 рублей.
Доставка сертификата по Москве стоит 700 рублей.
EOF

cat > "${TMP_DIR}/smoke-rag-v2.txt" <<EOF
Смоук-тест RAG ${RUN_ID} версия 2
Комплекс стрижка плюс борода стоит 2800 рублей.
Маникюр с покрытием гель-лаком стоит 3000 рублей.
EOF

echo "3. Upload through files[]"
upload_and_wait "files" "${TMP_DIR}/smoke-rag-v1.txt" "smoke-rag.txt"

echo "4. Upload through legacy file"
upload_and_wait "file" "${TMP_DIR}/smoke-rag-v2.txt" "smoke-rag.txt"

echo "5. Keyword search"
KEYWORD_RESULT="$(post_json "/knowledge-base/${INSTANCE_ID}/search" '{"query":"стрижкой","searchType":"keyword","k":3}')"
echo "$KEYWORD_RESULT" | python3 -m json.tool
KEYWORD_COUNT="$(echo "$KEYWORD_RESULT" | json_get "json.dumps(int(data.get('resultsCount', 0)))")"
[ "$KEYWORD_COUNT" -gt 0 ] || { echo "Keyword search returned no results"; exit 1; }

echo "6. Hybrid search"
HYBRID_RESULT="$(post_json "/knowledge-base/${INSTANCE_ID}/search" '{"query":"мужская стрижка сколько стоит","searchType":"hybrid","k":3}')"
echo "$HYBRID_RESULT" | python3 -m json.tool
HYBRID_COUNT="$(echo "$HYBRID_RESULT" | json_get "json.dumps(int(data.get('resultsCount', 0)))")"
[ "$HYBRID_COUNT" -gt 0 ] || { echo "Hybrid search returned no results"; exit 1; }

echo "7. Version history"
curl -sS "${BASE_URL}/api/knowledge-base/${INSTANCE_ID}/versions/smoke-rag.txt" | python3 -m json.tool

echo "8. Stats"
curl -sS "${BASE_URL}/api/knowledge-base/${INSTANCE_ID}/stats" | python3 -m json.tool

echo "9. Analytics"
curl -sS "${BASE_URL}/api/knowledge-base/${INSTANCE_ID}/analytics" | python3 -m json.tool

echo "10. Rebuild embeddings"
post_json "/knowledge-base/${INSTANCE_ID}/rebuild-embeddings" '{}' | python3 -m json.tool

echo "========================================="
echo "Shell smoke test passed"
echo "========================================="
