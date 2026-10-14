#!/usr/bin/env bash
# The setup action's script. Fails fast when the ai-platform-infra commit
# needs a newer ai-platform-workflows than this one (compat.json), reads the
# Terraform version, and exports what later steps use.
#
# In:  AIP_INFRA, the ai-platform-infra checkout.
# Out: AIP_INFRA, AIP_SCRIPTS, AIP_CHECKS and the Terraform settings in
#      GITHUB_ENV; terraform-version in GITHUB_OUTPUT.
set -euo pipefail

infra="$(realpath "${AIP_INFRA:?}")"
scripts="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
running="$(tr -d '[:space:]' < "$scripts/../version.txt")"
needed="$(jq -r '.minWorkflowsVersion' "$infra/compat.json")"

if [[ "$(printf '%s\n%s\n' "$running" "$needed" | sort -V | head -n 1)" != "$needed" ]]; then
  echo "::error::ai-platform-infra at this commit needs ai-platform-workflows $needed or later; this is $running"
  exit 1
fi

version="$(tr -d '[:space:]' < "$infra/.terraform-version")"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::.terraform-version does not hold a Terraform version"
  exit 1
fi

mkdir -p "$RUNNER_TEMP/terraform-plugins"
{
  echo "AIP_INFRA=$infra"
  echo "AIP_SCRIPTS=$scripts"
  echo "AIP_CHECKS=$infra/checks/bin/aip-checks.js"
  echo "TF_PLUGIN_CACHE_DIR=$RUNNER_TEMP/terraform-plugins"
  echo "TF_IN_AUTOMATION=true"
  echo "TF_INPUT=false"
} >> "$GITHUB_ENV"
echo "terraform-version=$version" >> "$GITHUB_OUTPUT"
