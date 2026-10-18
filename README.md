# ai-platform-workflows

Reusable GitHub Actions workflows, composite actions, GitOps modules and scripts for the AI Platform GitOps
repositories: `ai-platform-infra`, `ai-platform-environments`, `ai-platform-tenants` and
`ai-platform-deployments`. Design: `ai-platform-discovery-docs` design B `#workflows` and the
[GitOps contract](https://github.com/DEFRA/ai-platform-infra/blob/main/docs/gitops-contract.md).

## Workflows

| Workflow                     | Called from                     | Trigger in the caller               | Does                                                                                                                                                                                              |
| ---------------------------- | ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit-desired-state.yml`   | tenants, deployments            | `workflow_dispatch` (`submit.yml`)  | Validates at the pin, commits as the App on `op/{id}`, opens the PR and arms squash auto-merge; when nothing on `main` blocks the PR it waits for the validate check and merges itself; `abandon` |
| `validate-desired-state.yml` | tenants, deployments            | `pull_request`                      | Required check `validate-desired-state / validate` (the caller job must be named `validate-desired-state`), offline, at the pin of the one environment changed                                    |
| `apply-state.yml`            | deployments (`state: platform`) | push to `main`, `workflow_dispatch` | Platform apply with the safeguards and a run report, then dispatches the tenants apply                                                                                                            |
| `apply-state.yml`            | tenants (`state: tenants`)      | push to `main`, `workflow_dispatch` | Tenants apply once the platform apply covers the pin (R5), with the safeguards and a run report; purges the Entra registrations it removed                                                        |
| `validate-environments.yml`  | environments                    | `pull_request`, push to `main`      | Required check `validate-environments / validate`; dispatches the platform apply after a merge                                                                                                    |
| `infra-checks.yml`           | infra                           | `pull_request`                      | Required checks `infra-checks / validate`, `lint`, `schemas`, `catalogue`, `security` (checkov)                                                                                                   |
| `release.yml`                | infra (`kind: infra`), this     | push to `main`                      | release-please; infra submits `autoPin` pins; this repository moves the major tag                                                                                                                 |
| `release-merge.yml`          | infra, this                     | `workflow_run` of the PR checks     | The App merges the release-please PR once every check `main` requires has passed                                                                                                                  |
| `prune-op-branches.yml`      | tenants, deployments            | nightly `schedule`                  | Deletes `op/*` branches older than seven days with no open PR (R7)                                                                                                                                |
| `workflow-checks.yml`        | this repository                 | `pull_request`                      | `actionlint` and shellcheck, unit and script tests, lint and audit                                                                                                                                |

A push applies every environment whose folder changed since its last successful apply, so a run superseded
by a newer one (R1) loses nothing; a dispatch applies the environment it names.

## How they are built

Every tool comes from its vendor's action: `hashicorp/setup-terraform`, `azure/login`,
`terraform-linters/setup-tflint`, `bridgecrewio/checkov-action`, `googleapis/release-please-action`,
actionlint's own image and GitHub's `actions/*`. No vendor action runs Terraform against an `azurerm`
backend (HashiCorp's `tfc-workflows-github` drives HCP Terraform); `setup-terraform` installs the CLI for
later `run` steps to call, so the apply job runs it from `apply.sh`, which adds only what is this
platform's own: re-validation (R4), the CCoE-named backend, plan-guard (R2), break-glass, the Entra purge
and the run report. Terraform signs in to Azure by OIDC through `ARM_*` variables; the purge signs in
`az` with `azure/login`.

| Part                                          | What                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`gitops`](.github/actions/gitops/action.yml) | Runs one command from [`src/`](src) through `actions/github-script` with its authenticated Octokit, REST API version `2026-03-10`, retries on transient errors           |
| [`setup`](.github/actions/setup/action.yml)   | Checks out `ai-platform-infra` at a commit, fails fast on `compat.json`, installs Terraform at `.terraform-version` with a provider cache, and the `aip-checks` CLI      |
| [`src/`](src)                                 | The GitOps logic: resolving what to apply, preflight (R1), submit, abandon, prune, validation facts, dispatches, the release merge, the major tag and the `autoPin` pins |
| [`scripts/`](scripts)                         | `apply.sh` (plan, apply, purge, report), `desired-state.sh` (validate, stage), `setup.sh` and `infra-checks.sh`                                                          |

Workflows hold no inline logic: parameters reach the modules and scripts as `AIP_*` variables, never by
interpolating an expression into a script. Each job mints its own App token with only the permissions and
repositories it needs (`actions/create-github-app-token`).

## Using them

Callers and composite actions are referenced by major tag, `DEFRA/ai-platform-workflows/...@v1`; every other
action by its major tag too (`actions/checkout@v7`). Dependabot proposes new majors after a seven-day
cooldown. Workflow inputs are the only interface; repository names follow the convention
`{owner}/ai-platform-{name}`. A caller must set `secrets: inherit`: a reusable workflow receives no secrets
otherwise, and each workflow declares `GITOPS_APP_PRIVATE_KEY` as a required secret.

| Where                | Variables and secrets                                                                        | Branches |
| -------------------- | -------------------------------------------------------------------------------------------- | -------- |
| Secret               | `GITOPS_APP_PRIVATE_KEY`, the App key, one per repository or an organisation secret          | –        |
| Repository variables | `GITOPS_APP_CLIENT_ID` and `AZURE_TENANT_ID`, shared by every environment                    | –        |
| Environment `{env}`  | `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID` of `id-aip-deploy-{env}`; tenants and deployments | `main`   |

Only real environments (`infradev`, `dev`, `test`, `preprod`, `prod`) are GitHub Environments, and only the
apply jobs use them, so Azure issues a token only to a job on `main` in the matching Environment. An Environment
variable wins over a repository variable of the same name. In Phase 1 the one App is `ai-platform-orchestrator`.

Runners: each registry entry's `runner` decides where its apply jobs run, as standard labels
(`["ubuntu-26.04"]`, Phase 1) or a larger-runner group with Azure private networking (`{"group": "aip-{env}"}`,
the target). Changing it is a registry pull request, not a workflow change.

## Repository settings

Auto-merge only arms on a pull request something blocks, and `release-merge` merges nothing while `main`
requires no check, so every GitOps repository needs its ruleset. [`scripts/setup/repo-settings.sh`](scripts/setup)
applies them idempotently from the JSON in that folder (`--dry-run` prints the calls); design B `#rulesets`
is the source.

| Repositories                          | `main` ruleset                                                                                                              | Also                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ai-platform-tenants`, `-deployments` | Pull request required, no approvals; required check `validate-desired-state / validate`; squash only; no bypass             | Auto-merge allowed; Environments `{env}` on `main` only; no other Environment |
| `ai-platform-infra`, `-workflows`     | Pull request with one approval; the required checks of the PR workflow; squash only; the App bypasses to merge a release PR | Auto-merge allowed; tag ruleset `v*` creatable by the App only                |
| `ai-platform-environments`            | Pull request with one approval; required check `validate-environments / validate`; squash only                              | –                                                                             |

A disabled workflow is treated as an engineer's pause: a dispatch to it fails with `workflow-disabled` and
nothing re-enables it. The script lists any disabled workflow it finds.

## Releases

release-please tags `vX.Y.Z` from conventional commits and moves `vX` through the Git refs API.
`version.txt` is the running version that `setup` compares with an infra release's `compat.json`. The App
has no Workflows permission, so a release never edits `.github/workflows/`. A rerun of a release run that
failed after release-please made the release finds that release and finishes the major tag or the pins.
Only the release App may push to `release-please--branches--main`, and the release merge checks that the App
opened the pull request and wrote every commit on it.

The release workflows use this repository's own actions through `@v1`, so `v1` must exist before the first
release. Once, right after the first pull request merges, point it at `main`; the first release then moves
it to `v1.0.0`:

```sh
gh api repos/DEFRA/ai-platform-workflows/git/refs -f ref=refs/tags/v1 \
  -f sha="$(gh api repos/DEFRA/ai-platform-workflows/git/ref/heads/main --jq .object.sha)"
```

## Development

```sh
npm ci
npm run lint
npm test          # unit tests, and the script tests in bash with fake terraform and aip-checks
actionlint
shellcheck scripts/*.sh
```

The script tests need bash and jq. On Windows set `AIP_TEST_BASH` to Git Bash's `bash.exe`.

Licence: [Open Government Licence v3](LICENCE).
