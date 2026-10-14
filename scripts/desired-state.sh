#!/usr/bin/env bash
# Validates desired state in ai-platform-tenants or ai-platform-deployments
# with the checks of ai-platform-infra at the environment's pinned release:
#   desired-state.sh validate   a pull request, between its base and head
#   desired-state.sh stage      a submission: the change committed locally on
#                               main in state/, then validated the same way;
#                               exports AIP_MAIN_SHA, the main it was checked on
#
# In: AIP_KIND (tenants or pins), AIP_INFRA, AIP_CHECKS, AIP_CONFIG,
#     AIP_AUTHOR, AIP_OPERATION_ID; for validate AIP_BASE_SHA, AIP_HEAD_SHA,
#     AIP_LABELS and AIP_APPROVERS; for stage AIP_ACTION, AIP_PATH,
#     AIP_DOCUMENT_FILE, AIP_EXPECTED_REVISION and AIP_RELEASE.
set -euo pipefail

kind="${AIP_KIND:?}"

fail() {
  echo "::error::$2"
  printf '### %s\n\n%s\n' "$1" "$2" >> "$GITHUB_STEP_SUMMARY"
  exit 1
}

checks() {
  local args=(--repo state --base "$1" --head "$2" --infra "${AIP_INFRA:?}"
    --environments "$(realpath "${AIP_CONFIG:-config}")" --author "${AIP_AUTHOR:?}"
    --labels "${AIP_LABELS:-}" --approvers "${AIP_APPROVERS:-}")
  if [[ -n "${AIP_OPERATION_ID:-}" ]]; then
    args+=(--operation-id "$AIP_OPERATION_ID")
  fi
  node "${AIP_CHECKS:?}" "$kind" "${args[@]}"
}

validate() {
  checks "${AIP_BASE_SHA:?}" "${AIP_HEAD_SHA:?}"
}

stage() {
  local path="${AIP_PATH:?}" main current=0
  main="$(git -C state rev-parse HEAD)"

  if [[ "$kind" == "tenants" ]]; then
    if [[ -f "state/$path" ]]; then
      current="$(jq -r .revision "state/$path")"
    fi
    [[ "$current" == "${AIP_EXPECTED_REVISION:?}" ]] ||
      fail revision-conflict "main has revision $current of $path, not $AIP_EXPECTED_REVISION"
  fi

  if [[ "${AIP_ACTION:?}" == "write" ]]; then
    mkdir -p "state/$(dirname "$path")"
    cp "${AIP_DOCUMENT_FILE:?}" "state/$path"
    git -C state add -- "$path"
  else
    [[ -f "state/$path" ]] || fail checks-failed "$path does not exist on main"
    git -C state rm --quiet -- "$path"
  fi

  if git -C state diff --cached --quiet; then
    fail checks-failed "$path on main already holds this document"
  fi

  git -C state -c user.name=submit -c user.email=submit@invalid \
    commit --quiet --message "staged ${AIP_OPERATION_ID:?}"
  checks "$main" "$(git -C state rev-parse HEAD)" ||
    fail checks-failed "the change failed validation at ${AIP_RELEASE:?}; the log has the reasons"
  echo "AIP_MAIN_SHA=$main" >> "$GITHUB_ENV"
}

case "${1:-}" in
  validate | stage) "$1" ;;
  *)
    echo "usage: desired-state.sh validate|stage" >&2
    exit 2
    ;;
esac
