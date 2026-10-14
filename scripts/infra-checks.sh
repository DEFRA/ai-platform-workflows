#!/usr/bin/env bash
# ai-platform-infra's Terraform checks, from the root of its checkout: the
# format of every file, init and validate of every root module, and
# `terraform test` with mock providers wherever a tests/ folder exists (R10).
set -euo pipefail

terraform fmt -check -recursive

for root in platform tenants bootstrap names; do
  if [[ -d "$root" ]]; then
    terraform -chdir="$root" init -backend=false -input=false -lockfile=readonly > /dev/null
    terraform -chdir="$root" validate
  fi
done

while IFS= read -r dir; do
  echo "::group::terraform test $dir"
  terraform -chdir="$dir" init -backend=false -input=false > /dev/null
  terraform -chdir="$dir" test
  echo "::endgroup::"
done < <(find . -type d -name tests -not -path './checks/*' -not -path '*/.terraform/*' -exec dirname {} \; | sort)
