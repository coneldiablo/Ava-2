#!/usr/bin/env bash
set -euo pipefail

# Usage on the production host after images are built:
#   ./customer-call-analytics-rollout.sh preflight <reviewed-sha>
#   ./customer-call-analytics-rollout.sh deploy <reviewed-sha>
#   ./customer-call-analytics-rollout.sh rollback <reviewed-sha>
mode="${1:-preflight}"
sha="${2:?Pass the reviewed commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]
[[ "$mode" == preflight || "$mode" == deploy || "$mode" == rollback ]]
release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AVA_RELEASE_SHA="${AVA_RELEASE_SHA:-05c9083}"
export AVA_CALL_ANALYTICS_SHA="$sha"

project="$(docker inspect whatsapp_crm --format '{{ index .Config.Labels "com.docker.compose.project" }}')"
working_dir="$(docker inspect whatsapp_crm --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')"
config_list="$(docker inspect whatsapp_crm --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
[[ "$project" == asterisk-ai-voice-agent && "$working_dir" == /root/ava-current ]]
IFS=',' read -r -a config_files <<< "$config_list"
[[ "${#config_files[@]}" -gt 0 ]]

compose=(docker compose --project-directory "$working_dir" -p "$project")
for file in "${config_files[@]}"; do
    [[ -f "$file" ]]
    compose+=(-f "$file")
done
baseline=("${compose[@]}")

if [[ "$mode" == rollback ]]; then
    override="$release/customer-call-analytics.rollback.yml"
    expected_admin=ava-customer-admin:dd9c2e7-attempts
    expected_crm=ava-customer-crm:08e2288
else
    override="$release/customer-call-analytics.override.yml"
    expected_admin="ava-customer-admin:${sha}-calls"
    expected_crm="ava-customer-crm:${sha}"
fi
[[ -f "$override" ]]
compose+=(-f "$override")
docker image inspect "$expected_admin" "$expected_crm" >/dev/null
"${compose[@]}" config --quiet

for item in "admin_ui:$expected_admin" "whatsapp_crm:$expected_crm"; do
    service="${item%%:*}"
    expected="${item#*:}"
    resolved="$("${compose[@]}" config --format json | jq -r ".services.$service.image")"
    [[ "$resolved" == "$expected" ]]
    before="$("${baseline[@]}" config --format json | jq -S ".services.$service | del(.image)")"
    after="$("${compose[@]}" config --format json | jq -S ".services.$service | del(.image)")"
    [[ "$before" == "$after" ]] || { echo "$service-config-changed-beyond-image" >&2; exit 1; }
done

if [[ "$mode" == preflight ]]; then
    echo "preflight-ok sha=$sha admin=$expected_admin crm=$expected_crm"
    exit 0
fi

check_admin() {
    for _ in {1..30}; do
        if [[ "$(docker inspect admin_ui --format '{{.Config.Image}} {{.State.Status}}')" == "$expected_admin running" ]] \
            && docker exec admin_ui python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:3003/health", timeout=2).read()' >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    echo 'admin-health-failed' >&2
    return 1
}
check_crm() {
    for _ in {1..30}; do
        if [[ "$(docker inspect whatsapp_crm --format '{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')" == "$expected_crm running healthy" ]]; then
            return 0
        fi
        sleep 2
    done
    echo 'crm-health-failed' >&2
    return 1
}

if [[ "$mode" == rollback ]]; then
    "${compose[@]}" up -d --no-deps --no-build whatsapp_crm
    check_crm
    "${compose[@]}" up -d --no-deps --no-build admin_ui
    check_admin
else
    "${compose[@]}" up -d --no-deps --no-build admin_ui
    check_admin
    "${compose[@]}" up -d --no-deps --no-build whatsapp_crm
    check_crm
fi
echo "$mode-ok sha=$sha admin=$expected_admin crm=$expected_crm"
