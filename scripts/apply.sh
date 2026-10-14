#!/usr/bin/env bash
# One environment's apply job in apply-state.yml, with the apply safeguards
# of design C #safeguards:
#   apply.sh plan    re-validation on main (R4), sign-in checks, the state
#                    backend from the naming module, break-glass unlock (R6),
#                    a saved plan and plan-guard (R2)
#   apply.sh apply   applies the saved plan
#   apply.sh report  the run report (R3, R12), whatever happened before it
#
# Runs in the workspace that holds state/ (this repository), config/ (from
# ai-platform-environments) and the setup action's ai-platform-infra.
# In: AIP_STATE, AIP_ENVIRONMENT, AIP_RELEASE, AIP_ENTRA_ENABLED, AIP_BASE,
#     AIP_INFRA, AIP_CHECKS, AIP_CONFIG, AIP_OUTCOME (report), the break-glass
#     AIP_BREAK_GLASS, AIP_ALLOW_DESTROY and AIP_FORCE_UNLOCK, and ARM_*.
set -euo pipefail

state="${AIP_STATE:?}"
environment="${AIP_ENVIRONMENT:?}"
infra="${AIP_INFRA:?}"
config="$(realpath "${AIP_CONFIG:-config}")"
root="$infra/$state"
global="$config/global.tfvars.json"
params="$config/environments/$environment/platform.tfvars.json"
report_file="run-report-$environment.json"

checks() {
  node "${AIP_CHECKS:?}" "$@"
}

fail() {
  echo "::error::$1"
  exit 1
}

# Break-glass inputs are for an engineer's dispatch only, and are reported.
break_glass() {
  [[ "${AIP_BREAK_GLASS:-false}" == "true" ]] || fail "$1 is for an engineer's dispatch only"
  echo "### Break-glass: $1 by ${GITHUB_TRIGGERING_ACTOR:-unknown}" >> "$GITHUB_STEP_SUMMARY"
}

# The state backend's CCoE names, from the provider-free names root.
backend() {
  local vars="$RUNNER_TEMP/names.tfvars.json"
  jq -n --arg global "$global" --arg params "$params" \
    '{config_files: [$global, $params]}' > "$vars"
  terraform -chdir="$infra/names" init -backend=false -input=false > /dev/null
  terraform -chdir="$infra/names" apply -auto-approve -input=false -lock=false \
    -state="$RUNNER_TEMP/names.tfstate" -var-file="$vars" > /dev/null
  terraform -chdir="$infra/names" output -state="$RUNNER_TEMP/names.tfstate" -json backend
}

plan() {
  local guid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  local name
  for name in ARM_CLIENT_ID ARM_TENANT_ID ARM_SUBSCRIPTION_ID; do
    [[ "${!name:-}" =~ $guid ]] ||
      fail "$name is not set: set AZURE_CLIENT_ID and AZURE_SUBSCRIPTION_ID on the $environment Environment and AZURE_TENANT_ID on the repository"
  done
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] || fail "the job needs permissions: id-token: write"

  if [[ "$state" == "platform" ]]; then
    checks pin-on-main --repo state --ref "$GITHUB_SHA" --environment "$environment" \
      --infra "$infra" --environments "$config"
  else
    checks tenants-on-main --repo state --ref "$GITHUB_SHA" --environment "$environment" \
      --infra "$infra" --environments "$config"
    checks teams-variables --repo state --ref "$GITHUB_SHA" --environment "$environment" \
      --out "$root/teams.auto.tfvars.json"
  fi

  local location
  location="$(backend)"
  terraform -chdir="$root" init -input=false -lockfile=readonly \
    -backend-config="resource_group_name=$(jq -r .resource_group_name <<< "$location")" \
    -backend-config="storage_account_name=$(jq -r .storage_account_name <<< "$location")" \
    -backend-config="container_name=$(jq -r .container_name <<< "$location")" \
    -backend-config="key=$state.tfstate"

  if [[ -n "${AIP_FORCE_UNLOCK:-}" ]]; then
    [[ "$AIP_FORCE_UNLOCK" =~ ^[0-9a-f-]{36}$ ]] || fail "force_unlock takes the state lease ID"
    break_glass "force_unlock of lease $AIP_FORCE_UNLOCK"
    terraform -chdir="$root" force-unlock -force "$AIP_FORCE_UNLOCK"
  fi

  local vars=(-var "release=${AIP_RELEASE:?}" -var "entra_enabled=${AIP_ENTRA_ENABLED:?}")
  if [[ "$state" == "platform" ]]; then
    vars+=(-var-file="$global" -var-file="$params")
  else
    vars+=(-var "environment=$environment"
      -var "platform_state=$(jq -c '. + {key: "platform.tfstate"}' <<< "$location")")
  fi
  terraform -chdir="$root" plan -input=false -lock-timeout=15m -out=tfplan "${vars[@]}"
  terraform -chdir="$root" show -json tfplan > plan.json

  local guard=(--plan plan.json --state "$state")
  if [[ "$state" == "tenants" ]]; then
    guard+=(--repo state --head "$GITHUB_SHA" --environment "$environment")
    if [[ -n "${AIP_BASE:-}" ]]; then
      guard+=(--base "$AIP_BASE")
    fi
  fi
  if [[ "${AIP_ALLOW_DESTROY:-false}" == "true" ]]; then
    break_glass "allow_destroy"
    guard+=(--allow-destroy)
  fi
  checks plan-guard "${guard[@]}"
}

apply() {
  terraform -chdir="$root" apply -input=false -lock-timeout=15m -json tfplan |
    tee apply.jsonl | jq -r '."@message"'
}

report() {
  if [[ -d "$root/.terraform" ]]; then
    terraform -chdir="$root" output -json > outputs.json || rm -f outputs.json
  fi

  local args=(--repo state --head "$GITHUB_SHA" --environment "$environment" --state "$state"
    --outcome "${AIP_OUTCOME:?}" --release "${AIP_RELEASE:?}" --repository "$GITHUB_REPOSITORY"
    --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT"
    --run-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    --out "$report_file")
  if [[ -n "${AIP_BASE:-}" ]]; then
    args+=(--base "$AIP_BASE")
  fi
  if [[ -f plan.json ]]; then
    args+=(--plan plan.json)
  fi
  if [[ -f apply.jsonl ]]; then
    args+=(--apply-log apply.jsonl)
  fi
  if [[ -f outputs.json ]]; then
    args+=(--outputs outputs.json)
  fi
  checks run-report "${args[@]}"

  jq -r '"### \(.outcome)",
    "",
    "Changes: \(.changes.total.create) to add, \(.changes.total.update) to change, \(.changes.total.delete + .changes.total.replace) to destroy",
    "",
    "Operations: \([.operations[].operationIds[]] | join(", "))",
    "",
    "Failing teams: \(.failingTeams | join(", "))"' "$report_file" >> "$GITHUB_STEP_SUMMARY"
}

case "${1:-}" in
  plan | apply | report) "$1" ;;
  *)
    echo "usage: apply.sh plan|apply|report" >&2
    exit 2
    ;;
esac
