#!/usr/bin/env bash
# Applies the repository settings the GitOps workflows rely on (README,
# Repository settings), idempotently, for an administrator to run:
#
#   repo-settings.sh --app-id 5059913 --environments infradev[,dev,...] \
#     [--owner DEFRA] [--repos a,b] [--dry-run]
#
# For each repository in repositories.json: merge settings and auto-merge;
# the main ruleset from rulesets/, with the required checks and, in human
# repositories, the App as the pull-request bypass actor that merges a
# release; the v* tag ruleset where releaseTags is set; in machine
# repositories one Environment per real environment, allowing main only;
# legacy Environments removed; disabled workflows reported. Variables and
# secrets are not touched. --dry-run reads but prints every write.
set -euo pipefail

here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
owner=DEFRA
app_id=''
environments=''
only=''
dry_run=false

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) owner="$2"; shift 2 ;;
    --app-id) app_id="$2"; shift 2 ;;
    --environments) environments="$2"; shift 2 ;;
    --repos) only="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "::error::unknown argument $1"; usage ;;
  esac
done

if [[ ! "$app_id" =~ ^[0-9]+$ ]]; then
  echo "::error::--app-id must be the GitHub App's numeric ID"
  usage
fi

if [[ ! "$environments" =~ ^[a-z][a-z0-9]{1,15}(,[a-z][a-z0-9]{1,15})*$ ]]; then
  echo "::error::--environments must list the real environments, comma separated"
  usage
fi

manifest="$here/repositories.json"

# jq, with the carriage returns Windows builds add stripped.
q() {
  jq "$@" | tr -d '\r'
}

# A read; runs in a dry run too.
read_api() {
  gh api "$@"
}

# A write; printed, not run, in a dry run.
write_api() {
  if [[ "$dry_run" == true ]]; then
    echo "dry-run: gh api $*"
    return 0
  fi

  gh api "$@" > /dev/null
}

ruleset_body() {
  local template="$1" checks_json="$2" bypass_json="$3"

  jq --argjson checks "$checks_json" --argjson bypass "$bypass_json" '
    .bypass_actors = $bypass
    | (.rules[] | select(.type == "required_status_checks")
        | .parameters.required_status_checks) |= (
          if $checks == [] then . else
            [$checks[] | {context: ., integration_id: 15368}]
          end)
  ' "$here/rulesets/$template.json"
}

# Creates the ruleset or replaces the one of the same name.
upsert_ruleset() {
  local repo="$1" body="$2" name existing
  name="$(q -r .name <<< "$body")"
  existing="$(read_api "repos/$owner/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"

  if [[ -n "$existing" ]]; then
    write_api -X PUT "repos/$owner/$repo/rulesets/$existing" --input - <<< "$body"
    echo "$repo: ruleset $name updated"
  else
    write_api -X POST "repos/$owner/$repo/rulesets" --input - <<< "$body"
    echo "$repo: ruleset $name created"
  fi
}

ensure_environment() {
  local repo="$1" name="$2"

  write_api -X PUT "repos/$owner/$repo/environments/$name" --input - <<< '{
    "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
  }'

  if [[ "$(read_api "repos/$owner/$repo/environments/$name/deployment-branch-policies" \
      --jq '.branch_policies[] | select(.name == "main") | .id' 2> /dev/null)" == '' ]]; then
    write_api -X POST "repos/$owner/$repo/environments/$name/deployment-branch-policies" \
      -f name=main -f type=branch
  fi

  echo "$repo: Environment $name allows main only"
}

remove_environment() {
  local repo="$1" name="$2"

  if read_api "repos/$owner/$repo/environments/$name" --silent 2> /dev/null; then
    write_api -X DELETE "repos/$owner/$repo/environments/$name"
    echo "$repo: legacy Environment $name removed"
  fi
}

report_disabled_workflows() {
  local repo="$1" disabled
  disabled="$(read_api "repos/$owner/$repo/actions/workflows" --paginate \
    --jq '.workflows[] | select(.state != "active") | "\(.path) (\(.state))"')"

  if [[ -n "$disabled" ]]; then
    echo "::warning::$repo has disabled workflows; dispatches to them fail with workflow-disabled:"
    echo "$disabled"
  fi
}

configure_repository() {
  local repo="$1" kind checks release_tags legacy bypass env

  kind="$(q -r ".repositories[\"$repo\"].kind" "$manifest")"
  checks="$(q -c ".repositories[\"$repo\"].checks // []" "$manifest")"
  release_tags="$(q -r ".repositories[\"$repo\"].releaseTags // false" "$manifest")"
  legacy="$(q -r "(.legacyEnvironments + (.repositories[\"$repo\"].legacyEnvironments // [])) | unique | .[]" "$manifest")"

  write_api -X PATCH "repos/$owner/$repo" \
    -F allow_auto_merge=true -F allow_squash_merge=true \
    -F allow_merge_commit=false -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true \
    -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
  echo "$repo: squash only, auto-merge allowed, branches deleted on merge"

  case "$kind" in
    machine)
      upsert_ruleset "$repo" "$(ruleset_body machine-main '[]' '[]')"
      for env in ${environments//,/ }; do
        ensure_environment "$repo" "$env"
      done
      ;;
    human)
      # Only a repository that releases lets the App merge its release PR.
      bypass='[]'
      if [[ "$release_tags" == true ]]; then
        bypass="[{\"actor_id\": $app_id, \"actor_type\": \"Integration\", \"bypass_mode\": \"pull_request\"}]"
      fi
      upsert_ruleset "$repo" "$(ruleset_body human-main "$checks" "$bypass")"
      ;;
    *)
      echo "::error::$repo is not in $manifest"
      return 1
      ;;
  esac

  if [[ "$release_tags" == true ]]; then
    bypass="[{\"actor_id\": $app_id, \"actor_type\": \"Integration\", \"bypass_mode\": \"always\"}]"
    upsert_ruleset "$repo" "$(ruleset_body release-tags '[]' "$bypass")"
  fi

  for env in $legacy; do
    remove_environment "$repo" "$env"
  done

  report_disabled_workflows "$repo"
}

repos="$(q -r '.repositories | keys[]' "$manifest")"

if [[ -n "$only" ]]; then
  repos="${only//,/ }"
fi

for repo in $repos; do
  configure_repository "$repo"
done
