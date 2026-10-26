#!/usr/bin/env bash
# The audit-log half of the daily settings drift check (plan section 15,
# mitigation 4): lists what changed in the state repositories' rulesets,
# branch protection, Environments, Actions settings, collaborators and team
# access, deploy keys and webhooks, and exits 1 if there is anything, so the
# workflow fails and GitHub tells its watchers. An admin's own change shows
# too (an AIP_PAUSED change is an environment.update_actions_variable); the
# point is that none goes unseen.
#
#   audit-log.sh [--owner DEFRA] [--repos ai-platform-tenants,ai-platform-deployments] [--hours 26]
#
# Reads GET /orgs/{owner}/audit-log (GitHub Enterprise Cloud; the token needs
# organisation Administration: read, or the read:audit_log scope). The event
# names are those of GitHub's audit log reference for organisations (read
# from github/docs, src/audit-logs/data/ghec/organization.json, 26 October
# 2026): repository_ruleset.*, protected_branch.*, required_status_check.*,
# environment.*, hook.*, public_key.create and .delete (a deploy key added or
# removed), repo.add_member, .remove_member and .update_member, team.add_repository,
# .remove_repository and .update_repository_permission, and the repo Actions
# settings events.
# In: AIP_NOW (epoch seconds; for tests), GH_TOKEN.
set -euo pipefail

owner=DEFRA
repos='ai-platform-tenants,ai-platform-deployments'
hours=26

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) owner="$2"; shift 2 ;;
    --repos) repos="$2"; shift 2 ;;
    --hours) hours="$2"; shift 2 ;;
    *) echo "::error::unknown argument $1"; exit 1 ;;
  esac
done

if [[ ! "$hours" =~ ^[0-9]+$ ]]; then
  echo "::error::--hours must be a whole number"
  exit 1
fi

# What counts: every event of these kinds; protected_branch.rejected_ref_update
# is a refused push, not a change.
watched='^(repository_ruleset\.|protected_branch\.|required_status_check\.|environment\.|hook\.|public_key\.(create|delete)$|repo\.(add_member|remove_member|update_member|actions_enabled|update_actions_settings|update_actions_access_settings|update_actions_secret|update_actions_variable|set_actions_[a-z_]+)$|team\.(add_repository|remove_repository|update_repository_permission)$)'
ignored='^protected_branch\.rejected_ref_update$'

now="${AIP_NOW:-$(date -u +%s)}"
since=$((now - hours * 3600))
day="$(date -u -d "@$since" +%Y-%m-%d)"
found=0

for repo in ${repos//,/ }; do
  # created: is a whole day, so the hour window is applied below.
  events="$(gh api "orgs/$owner/audit-log" -f phrase="repo:$owner/$repo created:>=$day" \
    --paginate --jq '.[] | "\(.["@timestamp"]) \(.action) \(.actor // "unknown")"')"

  while read -r stamp action actor; do
    [[ -z "$stamp" ]] && continue
    ((stamp / 1000 >= since)) || continue
    [[ "$action" =~ $watched && ! "$action" =~ $ignored ]] || continue

    echo "::error::$repo: $action by $actor at $(date -u -d "@$((stamp / 1000))" +%Y-%m-%dT%H:%M:%SZ)"
    found=1
  done <<< "$events"
done

if ((found == 0)); then
  echo "No watched change in the last $hours hours."
fi

exit "$found"
