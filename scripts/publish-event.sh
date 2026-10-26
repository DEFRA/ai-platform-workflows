#!/usr/bin/env bash
# The second half of the publish-event action: sends the events build-event
# wrote (AIP_EVENT_FILE) to the events queue as the events identity, which has
# `sqs:SendMessage` and nothing else:
#   curl, az login                the job's OIDC token, signed in as
#                                 AIP_EVENTS_CLIENT_ID (in a config folder of
#                                 its own, leaving the job's sign-in alone)
#   az account get-access-token   a token for AIP_EVENTS_AUDIENCE
#   aws sts assume-role-with-web-identity   to AIP_EVENTS_ROLE_ARN
#   aws sqs send-message          to AIP_EVENTS_QUEUE_URL, one per event, in
#                                 the event's FIFO group, deduplicated by its ID
#
# Bounded, so a deploy never waits on it or fails on it: everything, the
# sign-in included, shares one deadline (AIP_PUBLISH_SECONDS, 10) and each call
# is retried at most twice (AIP_PUBLISH_RETRIES). An event that cannot be sent
# is a warning, never a failure; build-event has already kept every event in
# the run report.
#
# In: AIP_EVENT_FILE (a JSON array of {groupId, deduplicationId, body}),
#     AIP_EVENTS_QUEUE_URL, AIP_EVENTS_ROLE_ARN, AIP_EVENTS_AUDIENCE,
#     AIP_EVENTS_CLIENT_ID, AZURE_TENANT_ID, ACTIONS_ID_TOKEN_REQUEST_URL and
#     _TOKEN (the job's id-token: write), RUNNER_TEMP, GITHUB_RUN_ID,
#     GITHUB_RUN_ATTEMPT, optionally AWS_REGION (eu-west-2).
set -euo pipefail

budget="${AIP_PUBLISH_SECONDS:-10}"
retries="${AIP_PUBLISH_RETRIES:-2}"
region="${AWS_REGION:-eu-west-2}"
deadline=$((SECONDS + budget))

warn() {
  echo "::warning::publish-event: $1; the events stay in the run report"
}

remaining() {
  echo $((deadline - SECONDS))
}

# One call, killed when the shared deadline passes.
bounded() {
  local left
  left="$(remaining)"
  ((left > 0)) || return 124
  timeout "$left" "$@"
}

# The call, again up to $retries times while the deadline allows.
retry() {
  local attempt=0
  until bounded "$@"; do
    attempt=$((attempt + 1))
    if ((attempt > retries)) || (($(remaining) <= 1)); then
      return 1
    fi
    sleep 1
  done
}

mask() {
  echo "::add-mask::$1"
}

publish() {
  local file="${AIP_EVENT_FILE:-}"
  if [[ -z "$file" || ! -s "$file" ]]; then
    echo "No events to send."
    return 0
  fi

  if [[ -z "${AIP_EVENTS_QUEUE_URL:-}" || -z "${AIP_EVENTS_ROLE_ARN:-}" || -z "${AIP_EVENTS_AUDIENCE:-}" ||
    -z "${AIP_EVENTS_CLIENT_ID:-}" || -z "${AZURE_TENANT_ID:-}" ||
    -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
    echo "::notice::AIP_EVENTS_QUEUE_URL, AIP_EVENTS_ROLE_ARN, AIP_EVENTS_AUDIENCE, AIP_EVENTS_CLIENT_ID, AZURE_TENANT_ID and the job's id-token permission are not all set here, so no event is sent."
    return 0
  fi

  local work="${RUNNER_TEMP:?}/aip-events"
  local token_file="$work/token" oidc_file="$work/oidc.json"
  local token credentials oidc
  rm -rf "$work"
  (umask 077 && mkdir -p "$work")
  trap 'rm -rf "$work"' RETURN

  # Sign in as the events identity here, not in a step of its own, so the
  # sign-in shares the deadline; in a folder of its own, so the job's own
  # sign-in (the deploy identity's) is left as it was.
  export AZURE_CONFIG_DIR="$work/az"
  retry curl --silent --show-error --fail --max-time "$(remaining)" \
    --header "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    --output "$oidc_file" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=api://AzureADTokenExchange" || {
    warn "could not get the job's identity token"
    return 0
  }
  oidc="$(jq -r '.value // empty' "$oidc_file")"
  if [[ -z "$oidc" ]]; then
    warn "the job's identity token was empty"
    return 0
  fi
  mask "$oidc"

  retry az login --service-principal --username "$AIP_EVENTS_CLIENT_ID" \
    --tenant "$AZURE_TENANT_ID" --federated-token "$oidc" \
    --allow-no-subscriptions > /dev/null || {
    warn "could not sign in as the events identity"
    return 0
  }

  token="$(retry az account get-access-token --resource "$AIP_EVENTS_AUDIENCE" \
    --query accessToken --output tsv)" || {
    warn "could not get a token for the events audience"
    return 0
  }
  mask "$token"
  printf '%s' "$token" > "$token_file"

  credentials="$(retry aws sts assume-role-with-web-identity --region "$region" \
    --role-arn "$AIP_EVENTS_ROLE_ARN" \
    --role-session-name "aip-events-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}" \
    --web-identity-token "file://$token_file" --duration-seconds 900 \
    --query Credentials --output json)" || {
    warn "could not assume the events role"
    return 0
  }

  local key secret session
  key="$(jq -r .AccessKeyId <<< "$credentials")"
  secret="$(jq -r .SecretAccessKey <<< "$credentials")"
  session="$(jq -r .SessionToken <<< "$credentials")"
  mask "$secret"
  mask "$session"

  local count index body group dedup sent=0
  count="$(jq length "$file")"
  for ((index = 0; index < count; index++)); do
    body="$(jq -c ".[$index].body" "$file")"
    group="$(jq -r ".[$index].groupId" "$file")"
    dedup="$(jq -r ".[$index].deduplicationId" "$file")"

    if AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$session" \
      retry aws sqs send-message --region "$region" --queue-url "$AIP_EVENTS_QUEUE_URL" \
      --message-body "$body" --message-group-id "$group" \
      --message-deduplication-id "$dedup" --output text > /dev/null; then
      sent=$((sent + 1))
    else
      warn "could not send $dedup"
    fi
  done

  echo "Sent $sent of $count events."
}

# Never fails the run, whatever went wrong.
publish || warn "unexpected failure"
exit 0
