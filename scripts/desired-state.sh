#!/usr/bin/env bash
# Validates desired state in ai-platform-tenants or ai-platform-deployments
# with the checks of ai-platform-infra at the environment's pinned release:
#   desired-state.sh validate   a pull request, between its base and head
#   desired-state.sh stage      a submission: the change committed locally on
#                               main in state/, then validated the same way;
#                               exports AIP_MAIN_SHA, the main it was checked on
#   desired-state.sh restage    the same on the new head of main, after the
#                               head moved under a commit: fetches main,
#                               stages and validates again, and prints
#                               main-sha={the head} on stdout (everything else
#                               goes to stderr)
#
# Exit codes: 0 staged; 1 failed (checks-failed); 3 the base the request names
# is stale (stale-revision); 2 usage. A failure also exports AIP_FAILURE_CODE
# and AIP_FAILURE_MESSAGE for the step that reports it as an event.
#
# In: AIP_KIND (tenants or pins), AIP_INFRA, AIP_CHECKS, AIP_CONFIG,
#     AIP_AUTHOR, AIP_OPERATION_ID; for validate AIP_BASE_SHA, AIP_HEAD_SHA,
#     AIP_LABELS and AIP_APPROVERS; for stage AIP_ACTION, AIP_PATH,
#     AIP_DOCUMENT_FILE, AIP_EXPECTED_REVISION (team files), AIP_EXPECTED_BASE
#     (pins) and AIP_RELEASE; for restage also AIP_GIT_TOKEN.
set -euo pipefail

kind="${AIP_KIND:?}"
staged_main=''

# fail {code} {message} [exit code]
fail() {
  echo "::error::$2"
  printf '### %s\n\n%s\n' "$1" "$2" >> "$GITHUB_STEP_SUMMARY"
  {
    echo "AIP_FAILURE_CODE=$1"
    echo "AIP_FAILURE_MESSAGE=$2"
  } >> "$GITHUB_ENV"
  exit "${3:-1}"
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

# Every write names its base, an admin's too (AC20): the revision of a team
# file, or the blob SHA of the pin file ("0" for a file that does not exist).
# Anything else is stale-revision, which the Portal API rebuilds and resubmits.
check_base() {
  local path="$1" current=0

  if [[ "$kind" == "tenants" ]]; then
    if [[ -f "state/$path" ]]; then
      current="$(jq -r .revision "state/$path")"
    fi
    [[ "$current" == "${AIP_EXPECTED_REVISION:?}" ]] ||
      fail stale-revision "main has revision $current of $path, not $AIP_EXPECTED_REVISION" 3
  else
    if [[ -f "state/$path" ]]; then
      current="$(git -C state rev-parse "HEAD:$path")"
    fi
    [[ "$current" == "${AIP_EXPECTED_BASE:?}" ]] ||
      fail stale-revision "main has $path at $current, not the base $AIP_EXPECTED_BASE" 3
  fi
}

stage() {
  local path="${AIP_PATH:?}"
  staged_main="$(git -C state rev-parse HEAD)"

  check_base "$path"

  if [[ "${AIP_ACTION:?}" == "remove" ]]; then
    [[ -f "state/$path" ]] || fail checks-failed "$path does not exist on main"
    git -C state rm --quiet -- "$path"
  else
    mkdir -p "state/$(dirname "$path")"
    cp "${AIP_DOCUMENT_FILE:?}" "state/$path"
    git -C state add -- "$path"
  fi

  if git -C state diff --cached --quiet; then
    fail checks-failed "$path on main already holds this document"
  fi

  git -C state -c user.name=submit -c user.email=submit@invalid \
    commit --quiet --message "staged ${AIP_OPERATION_ID:?}"
  checks "$staged_main" "$(git -C state rev-parse HEAD)" ||
    fail checks-failed "the change failed validation at ${AIP_RELEASE:?}; the log has the reasons"
  echo "AIP_MAIN_SHA=$staged_main" >> "$GITHUB_ENV"
}

# The head of main moved under a commit: start again from the new head, with
# the same checks, so what is committed is what was validated. The checkout
# holds no credentials, so the fetch carries the token as checkout does.
restage() {
  local auth=()
  if [[ -n "${AIP_GIT_TOKEN:-}" ]]; then
    auth=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$AIP_GIT_TOKEN" | base64 | tr -d '\n')")
  fi

  git -C state "${auth[@]}" fetch --quiet origin main >&2
  git -C state reset --quiet --hard FETCH_HEAD >&2
  stage >&2
  echo "main-sha=$staged_main"
}

case "${1:-}" in
  validate | stage | restage) "$1" ;;
  *)
    echo "usage: desired-state.sh validate|stage|restage" >&2
    exit 2
    ;;
esac
