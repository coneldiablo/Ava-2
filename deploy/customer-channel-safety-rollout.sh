#!/usr/bin/env bash
set -euo pipefail

# Run from a reviewed release archive on the production host:
#   ./customer-channel-safety-rollout.sh preflight <commit-sha>
#   ./customer-channel-safety-rollout.sh deploy <commit-sha>
#   ./customer-channel-safety-rollout.sh rollback <commit-sha>
mode="${1:-preflight}"
sha="${2:?Pass the reviewed commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]
[[ "$mode" == preflight || "$mode" == deploy || "$mode" == rollback ]]
release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The currently active release files contain these required substitutions.
export AVA_RELEASE_SHA="${AVA_RELEASE_SHA:-05c9083}"
export AVA_CALL_ANALYTICS_SHA="${AVA_CALL_ANALYTICS_SHA:-da737f3}"
export AVA_CUSTOMER_CHANNELS_SHA="$sha"
export AVA_CUSTOMER_ROLLBACK_SHA="${AVA_CUSTOMER_ROLLBACK_SHA:-4040ed1}"
[[ "$AVA_CUSTOMER_ROLLBACK_SHA" =~ ^[0-9a-f]{7,40}$ ]]

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
    override="$release/customer-channel-safety.rollback.yml"
    expected="ava-customer-crm:$AVA_CUSTOMER_ROLLBACK_SHA"
else
    override="$release/customer-channel-safety.override.yml"
    expected="ava-customer-crm:$sha"
fi
[[ -f "$override" ]]
compose+=(-f "$override")
docker image inspect "$expected" >/dev/null
"${compose[@]}" config --quiet

resolved="$("${compose[@]}" config --format json | jq -r '.services.whatsapp_crm.image')"
[[ "$resolved" == "$expected" ]]
before="$("${baseline[@]}" config --format json | jq -S 'del(.services.whatsapp_crm.image)')"
after="$("${compose[@]}" config --format json | jq -S 'del(.services.whatsapp_crm.image)')"
[[ "$before" == "$after" ]] || { echo 'compose-config-changed-beyond-crm-image' >&2; exit 1; }

if [[ "$mode" == preflight ]]; then
    echo "preflight-ok sha=$sha crm=$expected"
    exit 0
fi

"${compose[@]}" up -d --no-deps --no-build whatsapp_crm
for _ in {1..30}; do
    state="$(docker inspect whatsapp_crm --format '{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')"
    if [[ "$state" == "$expected running healthy" ]]; then
        echo "$mode-ok sha=$sha crm=$expected"
        exit 0
    fi
    sleep 2
done
echo 'crm-health-failed' >&2
exit 1
