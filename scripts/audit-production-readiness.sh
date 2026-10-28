#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AVA_ROOT="${AVA_ROOT:-/root/ava-current}"
ADMIN_URL="${ADMIN_URL:-https://ai.meludtech.tech/login}"
CRM_URL="${CRM_URL:-https://wh.meludtech.tech/}"
# Force a second TLS check against the actual edge: origin DNS caches can retain
# the old host and otherwise hide broken public certificates/routing.
PUBLIC_EDGE_IP="${PUBLIC_EDGE_IP:-203.0.113.10}"
EXOLVE_ENDPOINT="${EXOLVE_ENDPOINT:-mts-exolve-9285348831}"
EXOLVE_LOG_LINES="${EXOLVE_LOG_LINES:-5000}"
CRM_DB="${CRM_DB:-$AVA_ROOT/data/whatsapp_crm/crm_v2.db}"
CALL_DB="${CALL_DB:-$AVA_ROOT/data/call_history.db}"

health_failures=0
acceptance_blocks=0

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; health_failures=$((health_failures + 1)); }
block() { printf 'BLOCK %s\n' "$*"; acceptance_blocks=$((acceptance_blocks + 1)); }

check_http() {
  name="$1"
  url="$2"
  shift 2
  code="$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' --max-time 15 "$@" "$url" || true)"
  if [ "$code" = "200" ]; then pass "$name HTTP 200"; else fail "$name HTTP $code"; fi
}

check_public_edge() {
  local name="$1" url="$2" authority
  authority="$(python3 -c 'import sys,urllib.parse; u=urllib.parse.urlsplit(sys.argv[1]); assert u.scheme == "https" and u.hostname; print(f"{u.hostname}:{u.port or 443}")' "$url")"
  check_http "$name (public edge $PUBLIC_EDGE_IP, verified TLS)" "$url" \
    --noproxy '*' --resolve "$authority:$PUBLIC_EDGE_IP"
}

check_container() {
  name="$1"
  require_health="${2:-false}"
  state="$(docker inspect --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$name" 2>/dev/null || true)"
  running="${state%%|*}"
  rest="${state#*|}"
  health="${rest%%|*}"
  restarts="${rest##*|}"
  if [ "$running" != "true" ]; then
    fail "container $name is not running"
  elif [ "$require_health" = "true" ] && [ "$health" != "healthy" ]; then
    fail "container $name health=$health"
  else
    pass "container $name health=$health restarts=$restarts"
  fi
}

printf 'AVA production readiness audit\n'
printf 'root=%s\n\n' "$AVA_ROOT"

for command in curl docker python3 asterisk systemctl journalctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done

if [ -d "$AVA_ROOT" ]; then pass "release directory exists"; else fail "release directory missing"; fi
check_container ai_engine
check_container admin_ui
check_container whatsapp_crm true
check_container whatsapp_crm_openwa true
check_container whatsapp_crm_redis true
check_container whatsapp_crm_telegram_proxy true
check_container xray-client

check_http "Admin UI" "$ADMIN_URL"
check_http "WhatsApp CRM" "$CRM_URL"
check_public_edge "Admin UI" "$ADMIN_URL"
check_public_edge "WhatsApp CRM" "$CRM_URL"
check_http "AI Engine" "http://127.0.0.1:15000/health"
if curl --fail --silent --max-time 10 http://127.0.0.1:15000/health | python3 -c \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="healthy" and d.get("ari_connected") is True else 1)'; then
  pass "AI runtime healthy and connected to ARI"
else
  fail "AI health body is degraded or ARI disconnected (HTTP 200 alone is insufficient)"
fi
check_http "OpenWA readiness" "http://127.0.0.1:2785/api/health/ready"
check_http "CRM health" "http://127.0.0.1:3011/api/health"

if [ "$(systemctl is-active asterisk 2>/dev/null || true)" = "active" ]; then
  pass "Asterisk service active"
else
  fail "Asterisk service inactive"
fi

if asterisk -rx 'pjsip show registrations' 2>/dev/null | grep -F "$EXOLVE_ENDPOINT" | grep -q 'Registered'; then
  pass "Exolve SIP registration active"
else
  fail "Exolve SIP registration is not active"
fi

if asterisk -rx 'ari show apps' 2>/dev/null | grep -q 'asterisk-ai-voice-agent'; then
  pass "ARI application registered"
else
  fail "ARI application missing"
fi

if python3 - "$CALL_DB" "$CRM_DB" <<'PY'
import sqlite3
import sys

for path in sys.argv[1:]:
    result = sqlite3.connect(path).execute("PRAGMA quick_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"{path}: {result}")
PY
then
  pass "SQLite quick_check for call history and CRM"
else
  fail "SQLite quick_check failed"
fi

openwa_tmp="$(mktemp)"
trap 'rm -f "$openwa_tmp"' EXIT
openwa_key="$(docker exec whatsapp_crm_openwa printenv API_MASTER_KEY 2>/dev/null || true)"
if [ -n "$openwa_key" ] && curl --fail --silent --show-error --max-time 15 \
  -H "X-API-Key: $openwa_key" http://127.0.0.1:2785/api/sessions >"$openwa_tmp"; then
  openwa_state="$(python3 - "$openwa_tmp" "$CRM_DB" <<'PY'
import json
import sqlite3
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
rows = data if isinstance(data, list) else data.get("data", [])
by_id = {str(row.get('id')): row for row in rows}
with sqlite3.connect(f'file:{sys.argv[2]}?mode=ro', uri=True) as db:
    bindings = db.execute("SELECT id, openWaSessionId FROM instances WHERE isActive=1 "
                          "AND COALESCE(whatsappProvider,'openwa') <> 'green_api'").fetchall()
states = []
for business_id, session_id in bindings:
    row = by_id.get(str(session_id), {})
    state = str(row.get('status') or row.get('state') or 'missing')
    states.append(state)
    print(f'OpenWA current business={business_id} state={state}', file=sys.stderr)
if states and all(state in {'ready','connected','authorized'} for state in states):
    print('ready')
elif states and all(state in {'ready','connected','authorized','qr_ready','authenticating','created','initializing','disconnected'} for state in states):
    print('authenticating')
else:
    print(','.join(states) if states else 'missing')
PY
)"
  case "$openwa_state" in
    ready|connected|authorized) pass "OpenWA WhatsApp session authorized" ;;
    qr_ready|authenticating|created|initializing|disconnected)
      block "OpenWA session=$openwa_state; scan QR in WhatsApp CRM"
      ;;
    *) fail "OpenWA unexpected session state=$openwa_state" ;;
  esac
else
  fail "OpenWA session API unavailable"
fi
rm -f "$openwa_tmp"
trap - EXIT

pms_state="$(python3 - "$CRM_DB" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
row = connection.execute(
    "SELECT connectionStatus, pollingStatus, webhookStatus, "
    "lastSuccessfulAvailabilityAt FROM pms_integrations "
    "WHERE businessId=1 AND provider='bnovo' AND enabled=1"
).fetchone()
print("missing" if row is None else "|".join(str(value or "") for value in row))
PY
)"
pms_worker_enabled="$(docker exec whatsapp_crm printenv PMS_ENABLED 2>/dev/null || true)"
if [ "$pms_worker_enabled" = "false" ]; then
  block "Bnovo background polling is disabled in the actual CRM process (PMS_ENABLED=false)"
fi
if [ "$pms_state" = "missing" ]; then
  fail "Bnovo integration missing"
else
  IFS='|' read -r pms_connection pms_polling pms_webhook pms_availability <<EOF
$pms_state
EOF
  case "$pms_connection" in connected|connected_limited) pass "Bnovo connection=$pms_connection" ;; *) fail "Bnovo connection=$pms_connection" ;; esac
  if [ "$pms_polling" = "healthy" ]; then pass "Bnovo stored polling status=healthy (freshness checked separately)"; else fail "Bnovo polling=$pms_polling"; fi
  if python3 - "$CRM_DB" <<'PY'
from datetime import datetime, timezone
import sqlite3, sys
connection=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro',uri=True)
row=connection.execute("SELECT lastSyncAt FROM pms_integrations WHERE businessId=1 AND provider='bnovo' AND enabled=1").fetchone()
try:
    value=datetime.fromisoformat(str(row[0]).replace('Z','+00:00'))
    if value.tzinfo is None: value=value.replace(tzinfo=timezone.utc)
    age=(datetime.now(timezone.utc)-value).total_seconds()
    assert 0 <= age <= 900
except (TypeError, ValueError, AssertionError):
    raise SystemExit(1)
PY
  then pass "Bnovo last successful sync is less than 15 minutes old"
  else block "Bnovo sync is stale or missing; stored healthy is not live evidence"; fi
  case "$pms_webhook" in active|receiving|activation_pending) pass "Bnovo webhook=$pms_webhook" ;;
    *) block "Bnovo webhook=$pms_webhook; provider permission is required" ;;
  esac
  if [ -n "$pms_availability" ]; then
    pass "Bnovo live availability has succeeded"
  else
    block "Bnovo live availability/tariff permission is required"
  fi
fi

if journalctl -u asterisk -n "$EXOLVE_LOG_LINES" --no-pager 2>/dev/null \
  | grep -E "Request 'INVITE'.*(80\\.75\\.130\\.(83|100)|login\\.mtt\\.ru)" >/dev/null; then
  pass "recent inbound Exolve INVITE observed"
else
  block "no correlated inbound Exolve call in the latest $EXOLVE_LOG_LINES log lines; trace a fresh test call and verify DID routing"
fi

env_value() {
  key="$1"
  value="$(sed -n "s/^${key}=//p" "$AVA_ROOT/.env" 2>/dev/null | tail -1 | tr -d '\042\047' | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$value"
}

if [ "$(env_value TWENTY_SYNC_ENABLED)" = "true" ]; then
  twenty_state="$(python3 - "$CRM_DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute("SELECT connectionStatus,mode FROM twenty_workspace_links WHERE businessId=1 AND enabled=1").fetchone()
failed = conn.execute("SELECT COUNT(*) FROM twenty_sync_outbox WHERE businessId=1 AND status IN ('DEAD','FAILED')").fetchone()[0]
print(f'{row[0]}|{row[1]}|{failed}' if row else 'unlinked')
PY
)"
  if [ "$twenty_state" = "connected|live|0" ]; then
    pass "Twenty live bridge connected; no failed outbox events"
  else
    block "Twenty bridge acceptance pending: $twenty_state"
  fi
else
  block "Twenty requires its dedicated VDS, DNS, TLS and workspace credentials"
fi

if [ "$(env_value ONYX_SYNC_ENABLED)" = "true" ]; then
  onyx_state="$(python3 - "$CRM_DB" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute("SELECT status FROM onyx_tenant_links WHERE business_id=1").fetchone()
print(row[0] if row else 'UNLINKED')
PY
)"
  case "$onyx_state" in
    ACTIVE|ACTIVE_LIVE) pass "Onyx live cutover status=$onyx_state" ;;
    *) block "Onyx ingestion configured; live grounding/cutover acceptance still pending ($onyx_state)" ;;
  esac
else
  block "Onyx requires its dedicated VDS, DNS, TLS and tenant credentials"
fi

printf '\nSUMMARY health_failures=%d acceptance_blocks=%d\n' "$health_failures" "$acceptance_blocks"
if [ "$health_failures" -gt 0 ]; then exit 1; fi
if [ "$acceptance_blocks" -gt 0 ]; then exit 2; fi
exit 0
