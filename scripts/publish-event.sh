#!/usr/bin/env bash
# The second half of the publish-event action: sends the events build-event
# wrote (AIP_EVENT_FILE) to the events queue as the events identity, which has
# `sqs:SendMessage` and nothing else:
#   curl   the job's OIDC token, then Entra's token endpoint, which takes it as
#          the client assertion of AIP_EVENTS_CLIENT_ID and returns a token
#          for AIP_EVENTS_AUDIENCE (no az, so no sign-in state to keep apart
#          from the job's)
#   aws sts assume-role-with-web-identity   to AIP_EVENTS_ROLE_ARN
#   aws sqs send-message-batch   to AIP_EVENTS_QUEUE_URL, up to 10 events a
#          call, each in its FIFO group and deduplicated by its ID
#
# Bounded, so a deploy never waits on it or fails on it: everything, the
# sign-in included, keeps to the deadline build-event set (AIP_EVENT_DEADLINE,
# from AIP_PUBLISH_SECONDS, whose default is in src/events.js). Only
# transient failures are retried, at most AIP_PUBLISH_RETRIES (2) times: curl
# and the AWS CLI retry timeouts, throttling and server errors themselves, and
# an event SQS failed on its side is sent again; a refusal is final. An event
# that cannot be sent is a warning, never a failure; build-event has already
# kept every event in the run report.
#
# In: AIP_EVENT_FILE (a JSON array of {groupId, deduplicationId, body}),
#     AIP_EVENTS_QUEUE_URL, AIP_EVENTS_ROLE_ARN, AIP_EVENTS_AUDIENCE,
#     AIP_EVENTS_CLIENT_ID, AZURE_TENANT_ID, ACTIONS_ID_TOKEN_REQUEST_URL and
#     _TOKEN (the job's id-token: write), AIP_EVENT_DEADLINE (epoch seconds,
#     from build-event), RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
#     optionally AWS_REGION (eu-west-2).
set -euo pipefail

retries="${AIP_PUBLISH_RETRIES:-2}"
region="${AWS_REGION:-eu-west-2}"
deadline=""
if [[ "${AIP_EVENT_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
  deadline=$((SECONDS + AIP_EVENT_DEADLINE - $(date +%s)))
fi
export AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=$((retries + 1))

# The run's summary page, so an event that was not sent is seen without
# reading the log.
summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

warn() {
  echo "::warning::publish-event: $1; the events stay in the run report"
  summary "- Status events: $1; the events stay in the run report"
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

# curl, retrying only what curl counts as transient (timeouts, 408, 429, 5xx).
fetch() {
  bounded curl --silent --show-error --max-time "$(remaining)" \
    --retry "$retries" --retry-max-time "$(remaining)" "$@"
}

mask() {
  echo "::add-mask::$1"
}

# iss, aud, sub (its first 8 characters: enough to tell which identity, not
# the object ID of a public log) and ver of a JWT: what the role's trust must
# match when it refuses the token. One line with no control characters, so no
# claim can write a workflow command. Empty when it is not a JWT.
claims() {
  local payload
  [[ "$1" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$ ]] || return 0
  payload="$(cut -d. -f2 <<< "$1" | tr '_-' '/+')"
  while ((${#payload} % 4 != 0)); do
    payload+="="
  done
  base64 -d <<< "$payload" 2> /dev/null |
    jq -r '"iss=\(.iss) aud=\(.aud) sub=\(.sub | tostring | .[0:8]) ver=\(.ver)"' 2> /dev/null |
    tr -d '\000-\037' || true
}

publish() {
  local file="${AIP_EVENT_FILE:-}"
  if [[ -z "$file" || ! -s "$file" ]]; then
    echo "No events to send."
    return 0
  fi

  local name joined configured=0 missing=()
  for name in AIP_EVENTS_QUEUE_URL AIP_EVENTS_ROLE_ARN AIP_EVENTS_AUDIENCE AIP_EVENTS_CLIENT_ID AZURE_TENANT_ID; do
    if [[ -n "${!name:-}" ]]; then
      configured=$((configured + 1))
    else
      missing+=("$name")
    fi
  done
  # None set is an environment without the queue, which the workflows allow;
  # some set is a mistake that would lose every event, so it is a warning.
  if ((configured == 0)); then
    echo "::notice::The events queue is not configured here (no AIP_EVENTS_* or AZURE_TENANT_ID), so no event is sent."
    return 0
  fi
  if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
    missing+=("the job's id-token: write permission")
  fi
  if [[ -z "$deadline" ]]; then
    missing+=("build-event's AIP_EVENT_DEADLINE")
  fi
  if ((${#missing[@]} > 0)); then
    joined="$(printf '%s, ' "${missing[@]}")"
    warn "the events queue is only partly configured here, missing ${joined%, }"
    return 0
  fi

  if (($(remaining) <= 0)); then
    warn "the time for reporting ran out before the events were built"
    return 0
  fi

  local work="${RUNNER_TEMP:?}/aip-events"
  local token_file="$work/token" oidc_file="$work/oidc.json"
  local assertion_file="$work/assertion" grant_file="$work/grant.json"
  local batch_file="$work/batch.json"
  local token credentials oidc seen reason
  rm -rf "$work"
  (umask 077 && mkdir -p "$work")
  trap 'rm -rf "$work"' RETURN

  fetch --fail --header "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
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
  printf '%s' "$oidc" > "$assertion_file"

  # No --fail: a refusal's body names the reason, as an AADSTS code.
  fetch --output "$grant_file" \
    --data-urlencode "client_id=$AIP_EVENTS_CLIENT_ID" \
    --data-urlencode grant_type=client_credentials \
    --data-urlencode client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer \
    --data-urlencode "client_assertion@$assertion_file" \
    --data-urlencode "scope=$AIP_EVENTS_AUDIENCE/.default" \
    "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" || true
  token="$(jq -r '.access_token // empty' "$grant_file" 2> /dev/null || true)"
  if [[ -z "$token" ]]; then
    reason="$(jq -r 'if .error_codes then "AADSTS\(.error_codes[0])" else .error // empty end' \
      "$grant_file" 2> /dev/null | tr -cd 'A-Za-z0-9_-' || true)"
    warn "could not get a token for the events audience${reason:+ ($reason)}"
    return 0
  fi
  mask "$token"
  printf '%s' "$token" > "$token_file"

  credentials="$(bounded aws sts assume-role-with-web-identity --region "$region" \
    --role-arn "$AIP_EVENTS_ROLE_ARN" \
    --role-session-name "aip-events-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}" \
    --web-identity-token "file://$token_file" --duration-seconds 900 \
    --query Credentials --output json)" || {
    warn "could not assume the events role"
    seen="$(claims "$token")"
    if [[ -n "$seen" ]]; then
      echo "::notice::publish-event: the token the role refused had $seen"
    fi
    return 0
  }

  local key secret session
  key="$(jq -r .AccessKeyId <<< "$credentials")"
  secret="$(jq -r .SecretAccessKey <<< "$credentials")"
  session="$(jq -r .SessionToken <<< "$credentials")"
  mask "$secret"
  mask "$session"

  local count batch pending response attempt line reasons n next why_next sent=0
  count="$(jq length "$file")"
  # Batches of 10, the most SQS takes in one call; an Id need only be unique
  # within its batch.
  while IFS= read -r batch; do
    pending="$batch"
    reasons='{}'
    for ((attempt = 0; attempt <= retries; attempt++)); do
      # A file, as ten large events can pass the limit on one argument.
      printf '%s' "$pending" > "$batch_file"
      response="$(AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$session" \
        bounded aws sqs send-message-batch --region "$region" \
        --queue-url "$AIP_EVENTS_QUEUE_URL" --entries "file://$batch_file" --output json)" || {
        reasons='{}'
        break
      }
      # A sender fault is final; anything else not sent is tried again. SQS's
      # code and message say why, on one line and briefly. One jq prints the
      # count sent, what to retry, why, then each refusal.
      {
        if ! { read -r n && read -r next && read -r why_next; }; then
          break
        fi
        sent=$((sent + n))
        while IFS= read -r line; do
          warn "could not send $line"
        done
      } < <(jq -r --argjson r "$response" '
        ($r.Successful // [] | map(.Id)) as $sent
        | ($r.Failed // []) as $failed
        | def why: .Id as $id | ($failed | map(select(.Id == $id)) | first) as $f
            | if $f then [$f.Code, $f.Message] | map(select(.)) | join(": ")
                | gsub("[[:cntrl:]]"; " ") | .[0:200]
              else "no result" end;
          def refused: .Id as $id | any($failed[]; .Id == $id and .SenderFault == true);
          def sent: .Id as $id | any($sent[]; . == $id);
          (map(select(sent)) | length),
          (map(select(sent or refused | not)) | tojson),
          (map(select(sent or refused | not) | {key: .MessageDeduplicationId, value: why})
            | from_entries | tojson),
          (.[] | select(refused) | "\(.MessageDeduplicationId) (\(why))")' <<< "$pending")
      pending="$next"
      reasons="$why_next"
      [[ "$pending" == '[]' ]] && break
    done
    while IFS= read -r line; do
      warn "could not send $line"
    done < <(jq -r --argjson why "$reasons" \
      '.[] | "\(.MessageDeduplicationId) (\($why[.MessageDeduplicationId] // "the batch call failed"))"' \
      <<< "$pending")
  done < <(jq -c '[to_entries[] | {Id: "e\(.key)", MessageBody: (.value.body | tojson),
    MessageGroupId: .value.groupId, MessageDeduplicationId: .value.deduplicationId}]
    | range(0; length; 10) as $i | .[$i:$i + 10]' "$file")

  echo "Sent $sent of $count events."
  summary "- Status events: sent $sent of $count to the events queue"
}

# Never fails the run, whatever went wrong.
publish || warn "unexpected failure"
exit 0
