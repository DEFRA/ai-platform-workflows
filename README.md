# ai-platform-workflows

Reusable GitHub Actions workflows, composite actions, GitOps modules and scripts for the AI Platform GitOps
repositories: `ai-platform-infra`, `ai-platform-environments`, `ai-platform-tenants` and
`ai-platform-deployments`. Design: `ai-platform-discovery-docs` design B `#workflows` and the
[GitOps contract](https://github.com/DEFRA/ai-platform-infra/blob/main/docs/gitops-contract.md).

## Workflows

| Workflow                     | Called from                     | Trigger in the caller                 | Does                                                                                                   |
| ---------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `submit-desired-state.yml`   | tenants, deployments            | `workflow_dispatch` (`submit.yml`)    | Validates at the pin, commits as the App on `op/{id}`, opens the PR, squash auto-merge; `abandon`      |
| `validate-desired-state.yml` | tenants, deployments            | `pull_request`, `pull_request_review` | Required check `validate-desired-state / validate`, offline, at the pin of the one environment changed |
| `apply-state.yml`            | deployments (`state: platform`) | push to `main`, `workflow_dispatch`   | Platform apply with the safeguards and a run report, then dispatches the tenants apply                 |
| `apply-state.yml`            | tenants (`state: tenants`)      | push to `main`, `workflow_dispatch`   | Tenants apply once the platform apply covers the pin (R5), with the safeguards and a run report        |
| `validate-environments.yml`  | environments                    | `pull_request`, push to `main`        | Required check `validate-environments / validate`; dispatches the platform apply after a merge         |
| `infra-checks.yml`           | infra                           | `pull_request`                        | Required checks `infra-checks / validate`, `lint`, `schemas`, `catalogue`, `security` (checkov)        |
| `release.yml`                | infra (`kind: infra`), this     | push to `main`                        | release-please; infra submits `autoPin` pins; this repository moves the major tag                      |
| `release-merge.yml`          | infra, this                     | `workflow_run` of the PR checks       | The App merges the release-please PR once every check `main` requires has passed                       |
| `prune-op-branches.yml`      | tenants, deployments            | nightly `schedule`                    | Deletes `op/*` branches older than seven days with no open PR (R7)                                     |
| `workflow-checks.yml`        | this repository                 | `pull_request`                        | `actionlint` and shellcheck, unit and script tests, lint and audit                                     |

A push applies every environment whose folder changed since its last successful apply, so a run superseded
by a newer one (R1) loses nothing; a dispatch applies the environment it names.

## How they are built

| Part                                          | What                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`gitops`](.github/actions/gitops/action.yml) | Runs one command from [`src/`](src) through `actions/github-script` with its authenticated Octokit, REST API version `2026-03-10`, retries on transient errors           |
| [`setup`](.github/actions/setup/action.yml)   | Checks out `ai-platform-infra` at a commit, fails fast on `compat.json`, installs Terraform at `.terraform-version` with a provider cache, and the `aip-checks` CLI      |
| [`src/`](src)                                 | The GitOps logic: resolving what to apply, preflight (R1), submit, abandon, prune, validation facts, dispatches, the release merge, the major tag and the `autoPin` pins |
| [`scripts/`](scripts)                         | `apply.sh` (plan, apply, report), `desired-state.sh` (validate, stage), `setup.sh` and `infra-checks.sh`                                                                 |

Workflows hold no inline logic: parameters reach the modules and scripts as `AIP_*` variables, never by
interpolating an expression into a script. Each job mints its own App token with only the permissions and
repositories it needs (`actions/create-github-app-token`).

## Using them

Callers and composite actions are referenced by major tag, `DEFRA/ai-platform-workflows/...@v1`; every other
action by its major tag too (`actions/checkout@v7`). Dependabot proposes new majors after a seven-day
cooldown. Workflow inputs are the only interface; repository names follow the convention
`{owner}/ai-platform-{name}`.

| Where                         | Variables and secrets                                                                          | Branches |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Repository variables          | `GITOPS_APP_CLIENT_ID` and `AZURE_TENANT_ID`, shared by every environment                      | –        |
| Environment `{env}`           | `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID` of `id-aip-deploy-{env}`; tenants and deployments   | `main`   |
| Environment `gitops-writer`   | Secret `GITOPS_APP_PRIVATE_KEY`; submit, in tenants and deployments                            | `main`   |
| Environment `gitops-reader`   | The same secret; read-only tokens for pull request checks and apply resolution                 | All      |
| Environment `gitops-dispatch` | The same secret; `actions: write` tokens to dispatch an apply, in deployments and environments | `main`   |
| Environment `release`         | The same secret; release-please and the release merge, in infra and this repository            | `main`   |

An Environment variable wins over a repository variable of the same name. Only the apply jobs create GitHub
Deployments; the others use `deployment: false`. In Phase 1 every Environment holds the one App,
`ai-platform-orchestrator`.

Runners: each registry entry's `runner` decides where its apply jobs run, as standard labels
(`["ubuntu-26.04"]`, Phase 1) or a larger-runner group with Azure private networking (`{"group": "aip-{env}"}`,
the target). Changing it is a registry pull request, not a workflow change.

## Releases

release-please tags `vX.Y.Z` from conventional commits and moves `vX` through the Git refs API.
`version.txt` is the running version that `setup` compares with an infra release's `compat.json`. The App
has no Workflows permission, so a release never edits `.github/workflows/`.

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
