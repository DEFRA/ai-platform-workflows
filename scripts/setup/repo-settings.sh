#!/usr/bin/env bash
# Applies the repository settings the GitOps workflows rely on (README,
# Repository settings), idempotently, for an administrator to run:
#
#   repo-settings.sh --app-id 5059913 --submit-app-ids 111,222 \
#     --environments infradev[,dev,...] [--admins-team aice-platform-admins] \
#     [--owner DEFRA] [--repos a,b] [--dry-run] [--verify]
#
# For each repository in repositories.json: merge settings and auto-merge;
# the main ruleset from rulesets/ with the required checks. Human repositories
# (infra, workflows, environments): the pull-request rule, the release App as
# the pull-request bypass actor where the repository releases, and the v* tag
# and release-branch rulesets. Machine repositories (tenants, deployments):
# aip-machine-main (a pull request with one approval and a code-owner review,
# and the validate check; bypassed by the submit Apps alone, --submit-app-ids,
# so they commit to main directly) and aip-machine-protect (force-push and
# deletion protection, no bypass), one Environment `{env}` and one
# `{env}-events` per real environment (main only, administrators cannot
# bypass, AIP_PAUSED=false when `{env}-events` is created), the team
# --admins-team as repository admin (to set AIP_PAUSED), legacy Environments
# removed, disabled workflows reported. Other variables and secrets are not
# touched.
#
# No person, team or administrator is ever a bypass actor (plan section 15,
# mitigations 1 and 6): every body is checked before it is sent, and the
# script stops if one lists anyone but the named Apps. --dry-run reads but
# prints every write. --verify is --dry-run that also reads the live settings
# and exits 1 on any difference from what this script would set, so a daily run
# detects drift (settings-drift.yml).
set -euo pipefail

here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
owner=DEFRA
app_id=''
submit_apps=''
admins_team=aice-platform-admins
environments=''
only=''
dry_run=false
verify=false
drift=0

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) owner="$2"; shift 2 ;;
    --app-id) app_id="$2"; shift 2 ;;
    --submit-app-ids) submit_apps="$2"; shift 2 ;;
    --admins-team) admins_team="$2"; shift 2 ;;
    --environments) environments="$2"; shift 2 ;;
    --repos) only="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --verify) verify=true; dry_run=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "::error::unknown argument $1"; usage ;;
  esac
done

if [[ ! "$app_id" =~ ^[0-9]+$ ]]; then
  echo "::error::--app-id must be the GitHub App's numeric ID"
  usage
fi

if [[ -n "$submit_apps" && ! "$submit_apps" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "::error::--submit-app-ids must be the numeric IDs of the Apps that run submit, comma separated"
  usage
fi

if [[ ! "$admins_team" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "::error::--admins-team must be the GitHub team's slug"
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

# A difference from what this script sets, found by --verify.
differs() {
  echo "::error::$1: $2"
  drift=1
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

# Integration bypass actors for a comma-separated list of App IDs.
app_bypass() {
  local ids="$1" mode="$2"

  jq -n -c --arg ids "$ids" --arg mode "$mode" '
    [$ids | split(",")[] | select(. != "") | {actor_id: tonumber, actor_type: "Integration", bypass_mode: $mode}]'
}

# Mitigations 1 and 6: a ruleset body lists no administrator, person or team
# as a bypass actor, only the Apps allowed (a JSON array of App IDs). Stops
# before anything is written.
assert_bypass() {
  local repo="$1" body="$2" allowed="$3" name

  name="$(q -r .name <<< "$body")"
  if ! jq -e --argjson allowed "$allowed" \
    '.bypass_actors | all(.actor_type == "Integration" and (.actor_id | IN($allowed[])))' \
    <<< "$body" > /dev/null; then
    echo "::error::$repo: $name would let someone other than the named Apps bypass it; stopping before any write"
    exit 1
  fi
}

# Checks the body, then creates the ruleset or replaces the one of the same name.
upsert_ruleset() {
  local repo="$1" body="$2" allowed="$3" name existing
  assert_bypass "$repo" "$body" "$allowed"
  name="$(q -r .name <<< "$body")"
  existing="$(read_api "repos/$owner/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"

  if [[ -n "$existing" ]]; then
    write_api -X PUT "repos/$owner/$repo/rulesets/$existing" --input - <<< "$body"
    echo "$repo: ruleset $name updated"
  else
    write_api -X POST "repos/$owner/$repo/rulesets" --input - <<< "$body"
    echo "$repo: ruleset $name created"
  fi

  if [[ "$verify" == true ]]; then
    verify_ruleset "$repo" "$name" "$body"
  fi
}

# The live ruleset has what this script would set: the target, active
# enforcement, exactly the bypass actors and exactly the rule types, each with
# the parameters wanted.
verify_ruleset() {
  local repo="$1" name="$2" body="$3" id live

  id="$(read_api "repos/$owner/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
  if [[ -z "$id" ]]; then
    differs "$repo" "ruleset $name is missing"
    return 0
  fi

  live="$(read_api "repos/$owner/$repo/rulesets/$id")"
  # Parameters are compared exactly for the keys this script sets (GitHub may
  # add defaults of its own), with lists in any order; a check renamed to
  # something that merely contains the wanted name differs. The branch
  # condition is compared exactly too.
  if ! jq -e -n --argjson want "$body" --argjson live "$live" '
    def actors: (. // []) | map({actor_id, actor_type, bypass_mode}) | sort_by(.actor_id);
    def norm: if type == "object" then map_values(norm)
      elif type == "array" then map(norm) | sort_by(tojson) else . end;
    def pick($w): if ($w | type) == "object" and type == "object" then
        . as $l | reduce ($w | keys_unsorted[]) as $k ({}; .[$k] = ($l[$k] | pick($w[$k])))
      else . end;
    def scope: {target, ref: (.conditions.ref_name // {} | {include: (.include // []), exclude: (.exclude // [])})} | norm;
    ($live.enforcement == "active")
    and ($live | scope) == ($want | scope)
    and ($live.bypass_actors | actors) == ($want.bypass_actors | actors)
    and (($live.rules | map(.type) | sort) == ($want.rules | map(.type) | sort))
    and ($want.rules | all(. as $rule
        | $live.rules | any(.type == $rule.type
            and (((.parameters // {}) | pick($rule.parameters // {}) | norm)
              == (($rule.parameters // {}) | norm)))))
  ' > /dev/null; then
    differs "$repo" "ruleset $name is not as this script sets it (enforcement, branch scope, bypass actors or rules)"
  fi
}

# Mitigation 1 across every ruleset of the repository, ours or not: no bypass
# actor that is not an App.
verify_no_person_bypass() {
  local repo="$1" id line

  while read -r id line; do
    [[ -z "$id" ]] && continue

    if ! read_api "repos/$owner/$repo/rulesets/$id" | jq -e \
      '(.bypass_actors // []) | all(.actor_type == "Integration")' > /dev/null; then
      differs "$repo" "ruleset $line lets a person, a team or a role bypass it"
    fi
  done < <(read_api "repos/$owner/$repo/rulesets" --jq '.[] | "\(.id) \(.name)"')
}

ensure_environment() {
  local repo="$1" name="$2" policies has_main=false id type policy_name

  # Mitigation 6: administrators cannot bypass the Environment's protection.
  write_api -X PUT "repos/$owner/$repo/environments/$name" --input - <<< '{
    "can_admins_bypass": false,
    "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
  }'

  # Reconcile, not append: anything but the branch policy named main goes,
  # a tag policy of that name included, so "main only" is what remains.
  policies="$(read_api "repos/$owner/$repo/environments/$name/deployment-branch-policies" \
    --jq '.branch_policies[] | "\(.id) \(.type // "branch") \(.name)"' 2> /dev/null || true)"

  while read -r id type policy_name; do
    [[ -z "$id" ]] && continue

    if [[ "$type" == branch && "$policy_name" == main ]]; then
      has_main=true
      continue
    fi

    write_api -X DELETE "repos/$owner/$repo/environments/$name/deployment-branch-policies/$id"
    echo "$repo: Environment $name no longer allows $type $policy_name"
  done <<< "$policies"

  if [[ "$has_main" != true ]]; then
    write_api -X POST "repos/$owner/$repo/environments/$name/deployment-branch-policies" \
      -f name=main -f type=branch
  fi

  echo "$repo: Environment $name allows main only, and administrators cannot bypass it"

  if [[ "$name" == *-events ]]; then
    ensure_paused_variable "$repo" "$name"
  fi

  if [[ "$verify" == true ]]; then
    verify_environment "$repo" "$name"
  fi
}

# AIP_PAUSED starts false, only when the Environment has none: a pause an admin
# set is never reset by running this again.
ensure_paused_variable() {
  local repo="$1" name="$2"

  if read_api "repos/$owner/$repo/environments/$name/variables/AIP_PAUSED" --silent 2> /dev/null; then
    return 0
  fi

  write_api -X POST "repos/$owner/$repo/environments/$name/variables" \
    -f name=AIP_PAUSED -f value=false
  echo "$repo: Environment $name has AIP_PAUSED=false"
}

verify_environment() {
  local repo="$1" name="$2" environment admins branches

  environment="$(read_api "repos/$owner/$repo/environments/$name" 2> /dev/null || echo missing)"
  if [[ "$environment" == missing ]]; then
    differs "$repo" "Environment $name is missing"
    return 0
  fi

  admins="$(jq -r '.can_admins_bypass' <<< "$environment")"
  if [[ "$admins" != false ]]; then
    differs "$repo" "Environment $name lets administrators bypass its protection"
  fi

  # The policy list only counts when the Environment enforces it: custom
  # branch policies on, and not the protected-branches or unrestricted mode.
  if ! jq -e '.deployment_branch_policy.custom_branch_policies == true
      and .deployment_branch_policy.protected_branches == false' <<< "$environment" > /dev/null; then
    differs "$repo" "Environment $name does not enforce its custom branch policies (it is unrestricted or limited to protected branches)"
  fi

  branches="$(read_api "repos/$owner/$repo/environments/$name/deployment-branch-policies" \
    --jq '.branch_policies[] | "\(.type // "branch") \(.name)"' 2> /dev/null || true)"
  if [[ "$branches" != "branch main" ]]; then
    differs "$repo" "Environment $name does not allow the branch main alone"
  fi

  if [[ "$name" == *-events ]] &&
    ! read_api "repos/$owner/$repo/environments/$name/variables/AIP_PAUSED" --silent 2> /dev/null; then
    differs "$repo" "Environment $name has no AIP_PAUSED"
  fi
}

# The admins team administers the machine repositories, to set AIP_PAUSED, and
# no others.
ensure_admins_team() {
  local repo="$1" role

  write_api -X PUT "orgs/$owner/teams/$admins_team/repos/$owner/$repo" -f permission=admin
  echo "$repo: $admins_team is repository admin"

  if [[ "$verify" == true ]]; then
    role="$(read_api "orgs/$owner/teams/$admins_team/repos/$owner/$repo" \
      -H 'Accept: application/vnd.github.v3.repository+json' --jq '.role_name' 2> /dev/null || echo none)"
    if [[ "$role" != admin ]]; then
      differs "$repo" "$admins_team is not repository admin (it is $role)"
    fi
  fi
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

configure_machine() {
  local repo="$1" apps_json env main_body

  if [[ -z "$submit_apps" ]]; then
    echo "::error::--submit-app-ids is needed for $repo: the Apps that run submit bypass aip-machine-main"
    return 1
  fi

  apps_json="$(jq -n -c --arg ids "$submit_apps" '[$ids | split(",")[] | tonumber]')"

  main_body="$(ruleset_body machine-main '[]' "$(app_bypass "$submit_apps" always)")"
  # Checked before the first write, so a refusal still leaves nothing changed.
  assert_bypass "$repo" "$main_body" "$apps_json"

  # The no-bypass protection ruleset (deletion, force push) goes first: replacing
  # a v1 main ruleset drops those rules, so a run that fails between the two
  # writes must never leave the repository without them.
  upsert_ruleset "$repo" "$(ruleset_body machine-protect '[]' '[]')" '[]'

  # The Apps that run submit commit to main directly, so they alone bypass the
  # pull-request rule; nobody else does, administrators included.
  upsert_ruleset "$repo" "$main_body" "$apps_json"

  for env in ${environments//,/ }; do
    ensure_environment "$repo" "$env"
    ensure_environment "$repo" "$env-events"
  done

  ensure_admins_team "$repo"
}

configure_human() {
  local repo="$1" checks="$2" release_tags="$3" bypass allowed

  # Only a repository that releases lets the App merge its release PR.
  bypass='[]'
  allowed='[]'
  if [[ "$release_tags" == true ]]; then
    bypass="[{\"actor_id\": $app_id, \"actor_type\": \"Integration\", \"bypass_mode\": \"pull_request\"}]"
    allowed="[$app_id]"
  fi
  upsert_ruleset "$repo" "$(ruleset_body human-main "$checks" "$bypass")" "$allowed"

  if [[ "$release_tags" == true ]]; then
    # The App alone writes the release branch and the v* tags, so a release
    # pull request the App merges through its bypass holds only its commits.
    bypass="[{\"actor_id\": $app_id, \"actor_type\": \"Integration\", \"bypass_mode\": \"always\"}]"
    upsert_ruleset "$repo" "$(ruleset_body release-branch '[]' "$bypass")" "[$app_id]"
    upsert_ruleset "$repo" "$(ruleset_body release-tags '[]' "$bypass")" "[$app_id]"
  fi
}

configure_repository() {
  local repo="$1" kind checks release_tags legacy env

  kind="$(q -r ".repositories[\"$repo\"].kind" "$manifest")"

  # Nothing is written to a repository the manifest does not describe.
  if [[ "$kind" != machine && "$kind" != human ]]; then
    echo "::error::$repo is not in $manifest"
    return 1
  fi

  checks="$(q -c ".repositories[\"$repo\"].checks // []" "$manifest")"
  release_tags="$(q -r ".repositories[\"$repo\"].releaseTags // false" "$manifest")"
  legacy="$(q -r "(.legacyEnvironments + (.repositories[\"$repo\"].legacyEnvironments // [])) | unique | .[]" "$manifest")"

  write_api -X PATCH "repos/$owner/$repo" \
    -F allow_auto_merge=true -F allow_squash_merge=true \
    -F allow_merge_commit=false -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true \
    -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
  echo "$repo: squash only, auto-merge allowed, branches deleted on merge"

  if [[ "$kind" == machine ]]; then
    configure_machine "$repo"
  else
    configure_human "$repo" "$checks" "$release_tags"
  fi

  for env in $legacy; do
    remove_environment "$repo" "$env"
  done

  if [[ "$verify" == true ]]; then
    verify_no_person_bypass "$repo"
  fi

  report_disabled_workflows "$repo"
}

repos="$(q -r '.repositories | keys[]' "$manifest")"

if [[ -n "$only" ]]; then
  repos="${only//,/ }"
fi

for repo in $repos; do
  configure_repository "$repo"
done

exit "$drift"
