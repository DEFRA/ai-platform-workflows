# ai-platform-workflows

Reusable GitHub Actions workflows, composite actions, GitOps modules and scripts for the AI Platform GitOps
repositories: `ai-platform-infra`, `ai-platform-environments`, `ai-platform-tenants` and
`ai-platform-deployments`. Design: `ai-platform-discovery-docs` design B `#workflows`, the
[plan](https://github.com/DEFRA/ai-platform-discovery-docs/blob/main/docs/async-operations-plan.md) (section 5) and the
[GitOps contract](https://github.com/DEFRA/ai-platform-infra/blob/main/docs/gitops-contract.md).

**v2** (D09, revised 25 October 2026): a portal change is a signed commit to `main`, not a pull request, and every
run reports its status as events. A person is no longer needed to merge, so `abandon`, the pull request, auto-merge,
the merge loop and `prune-op-branches.yml` are gone, and callers move to `@v2`.

## Workflows

| Workflow                     | Called from                     | Trigger in the caller                   | Does                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit-desired-state.yml`   | tenants, deployments            | `workflow_dispatch` (`submit.yml`)      | Admin check; validates at the pin; commits to `main` as the App (signed, `Operation-Id`, `Requested-By`, `Traceparent`); `write`, `remove` or `revert`; sends `requested`, then `committed` or `checks-failed`                                 |
| `validate-desired-state.yml` | tenants, deployments            | `pull_request`, `pull_request_review`   | Required check `validate-desired-state / validate` (the caller job must be named `validate-desired-state`), offline, at the pin of the one environment changed; a pull request that changes nothing under `environments/` passes once approved |
| `apply-state.yml`            | deployments (`state: platform`) | push to `main`, `workflow_dispatch`     | Admin check; ruleset check; platform apply with the safeguards, a run report and events, then dispatches the tenants apply                                                                                                                     |
| `apply-state.yml`            | tenants (`state: tenants`)      | push to `main`, `workflow_dispatch`     | Tenants apply once the platform apply covers the pin (R5), with the safeguards, a run report and events; purges the Entra registrations it removed                                                                                             |
| `apply-state.yml`            | tenants, deployments            | nightly `schedule`, `workflow_dispatch` | `reconcile-all.yml`: the same with `all: true`, which applies every environment from `main`                                                                                                                                                    |
| `pause.yml`                  | tenants, deployments            | `workflow_dispatch` (`pause.yml`)       | Admins only: reads `AIP_PAUSED` in `{env}-events` and publishes `paused` or `resumed`; writes nothing                                                                                                                                          |
| `validate-environments.yml`  | environments                    | `pull_request`, push to `main`          | Required check `validate-environments / validate`; dispatches the platform apply after a merge                                                                                                                                                 |
| `infra-checks.yml`           | infra                           | `pull_request`                          | Required checks `infra-checks / validate`, `lint`, `schemas`, `catalogue`, `security` (checkov)                                                                                                                                                |
| `release.yml`                | infra (`kind: infra`), this     | push to `main`                          | release-please; infra submits `autoPin` pins, each naming its base; this repository moves the major tag                                                                                                                                        |
| `release-merge.yml`          | infra, this                     | `workflow_run` of the PR checks         | The App merges the release-please PR once every check `main` requires has passed                                                                                                                                                               |
| `workflow-checks.yml`        | this repository                 | `pull_request`                          | `actionlint` and shellcheck, unit and script tests, lint and audit                                                                                                                                                                             |
| `settings-drift.yml`         | this repository                 | daily `schedule`, `workflow_dispatch`   | `repo-settings.sh --verify` and the audit log of the machine repositories: fails on any difference or change                                                                                                                                   |

A push applies every environment whose folder changed since its last successful apply, so a run superseded
by a newer one (R1) loses nothing; a dispatch applies the environment it names; `all` applies every environment.
`environment` and `all` exclude each other.

### What a state repository calls (v2)

| Caller file         | Inputs                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit.yml`        | `action` (`write`, `remove`, `revert`), `environment`, `path`, `document`, `operation_id` (optional), `expected_revision` (team file, 0 for new), `expected_base` (pin: the file's blob SHA on `main`, 0 for new), `requested_by`, `trace_parent`, `cdp_request_id`. The job must keep `run-name: submit {action} {path} ({operation_id})`, which the GitOps worker finds runs by |
| `apply.yml`         | `environment`, `reason`, `allow_destroy`, `force_unlock` (the last two for admins only)                                                                                                                                                                                                                                                                                           |
| `validate.yml`      | `pull_request` and `pull_request_review`, job named `validate-desired-state`                                                                                                                                                                                                                                                                                                      |
| `pause.yml`         | `environment`                                                                                                                                                                                                                                                                                                                                                                     |
| `reconcile-all.yml` | Nightly and by engineers; calls `apply-state.yml` with `all: true` and no break-glass input. The apply keys its exemption from the admin check on this file on `main`, so it is code-owned                                                                                                                                                                                        |

`submit` commits with `createCommitOnBranch` and `expectedHeadOid`, so the file lands on the head it was validated
against or not at all. When the head has moved it stages and validates again on the new head, after one to three
seconds, up to three attempts, then ends `commit-conflict` and sends no terminal event (the reconciler dispatches
again). A base that no longer matches (`expected_revision` of a team file, `expected_base` of a pin) ends
`stale-revision`; both it and `paused` commit nothing and send `checks-failed` with `failureReason.retryable: true`.
A hand run makes its own operation ID (`hand-{run ID}`) and is refused one that is passed in. A repeat dispatch of an
operation that already committed commits nothing and sends `committed` again.

## Events

Every `submit`, apply and `pause.yml` run sends its status to the events queue as `aip.gitops.event/1`
([schema](https://github.com/DEFRA/ai-platform-infra/tree/main/schemas/messages)), one event per operation, so the
Portal API follows the run without polling GitHub:

| Run    | Events                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| submit | `requested` (adds the run to the operation), then `committed`, or `checks-failed` with a failure reason (`checks-failed`, or the retryable `stale-revision` or `paused`)                                                                                                                                                                                                                                                                                            |
| apply  | `deploying` after the preflight and the pause check, then `deployed` or `deploy-failed` (with `failingTeams` and `attributable`), for each ID in the run report's `operations[].operationIds[]`; a commit with no operation ID is a `break-glass` event (with the pull request that carried it) or, with none, an `apply` event about the commit; a run with no operation is one event about the commit it applied. A superseded, empty or cancelled run sends none |
| pause  | `paused` or `resumed` for the environment                                                                                                                                                                                                                                                                                                                                                                                                                           |

An apply event names the operation's team and its file, and the commit and when it was made (`committedAt`), which it
reads from the commit with the job's `contents: read` token, because the run report holds only the commit. `deployed`
carries `appliedSha` and `resources[]`, flattened from the team's entry in the run report's `outputs.teams.value` (empty
for a removal). An event that cannot name those is not built, and the reconciler covers the gap. A test builds every
status the workflows send through `build-event` and checks it with Ajv against a copy of the schema
(`tests/fixtures/aip-gitops/event.schema.json`, byte-identical to infra's; set `AIP_INFRA_SCHEMAS` to a checkout's
`schemas/messages` to prove it), so the two cannot drift unseen.

The [`publish-event`](.github/actions/publish-event/action.yml) action first keeps each event in the run report's
`events[]` (submit and `pause.yml` upload a report that holds only them), so an event that cannot be sent is still
kept with the run. It then signs in with `azure/login` as the events identity (`AIP_EVENTS_CLIENT_ID`), gets a token
for `AIP_EVENTS_AUDIENCE`, assumes `AIP_EVENTS_ROLE_ARN` and sends to `AIP_EVENTS_QUEUE_URL`, in the FIFO group of the
operation (the commit for `break-glass` and for an apply no operation asked for, the environment for `pause`) and deduplicated by the event ID. It is bounded
to 10 seconds in all, the lookups of an apply's commits and pull requests included (a lookup that outlives the budget
is aborted and the run report keeps no event), with 2 retries on the send, and is `continue-on-error`: a deploy never
fails on it. An event from a run that no
operation asked for, sent while SQS is down for the whole run, may never reach the portal history; the run report and
GitHub's run history still hold it (accepted gap, plan section 15).

## Who may dispatch

The first job of `submit`, the apply and `pause.yml` is an admin check, before any token is minted or Environment named.
It applies to `workflow_dispatch` only; a push or a schedule is not checked.

| Actor                                                                                                 | Allowed                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-platform-orchestrator[bot]`, `ai-platform-orchestrator-infradev[bot]`, `ai-platform-release[bot]` | `submit` and the apply, by exact login, and an engineer may re-run the failed jobs of such a run. Not `github-actions[bot]`: `GITHUB_TOKEN` can trigger a `workflow_dispatch`                                                                                                                                                            |
| Anyone else                                                                                           | Only with the repository admin role (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`, which includes organisation and enterprise owners). A hand write, `pause.yml`, `allow_destroy` and `force_unlock` need it for both `github.actor` and `github.triggering_actor`, because a re-run keeps the first one's privileges |
| An engineer's `reconcile-all`                                                                         | Allowed when `github.workflow_ref` is `reconcile-all.yml` on `refs/heads/main` of this repository, `all` is `true` and no break-glass input is set                                                                                                                                                                                       |

## Pause

An admin sets `AIP_PAUSED` (`true` or `false`) on the `{env}-events` Environment of both state repositories and runs
`pause.yml`. The workflows read the variable themselves, so a lost `paused` event cannot let an automatic write through:
while it is `true`, `submit` refuses an exempt App's write (`paused`, retryable) and an apply an exempt App dispatched
reads it in a first job on `{env}-events` and, after its preflight, applies nothing and sends `deploy-failed` with the
retryable code `paused`. Pushes and an admin's hand runs go through.

## How they are built

Every tool comes from its vendor's action: `hashicorp/setup-terraform`, `azure/login`,
`terraform-linters/setup-tflint`, `bridgecrewio/checkov-action`, `googleapis/release-please-action`,
actionlint's own image and GitHub's `actions/*`. No vendor action runs Terraform against an `azurerm`
backend (HashiCorp's `tfc-workflows-github` drives HCP Terraform); `setup-terraform` installs the CLI for
later `run` steps to call, so the apply job runs it from `apply.sh`, which adds only what is this
platform's own: re-validation (R4), the CCoE-named backend, plan-guard (R2), break-glass, the Entra purge
and the run report. Terraform signs in to Azure by OIDC through `ARM_*` variables; the purge signs in
`az` with `azure/login`.

The apply refuses to run when the state repository's rulesets are not as the design has them: `aip-machine-main`
and `aip-machine-protect` must both exist and be active, the first bypassed by the submit Apps alone and still
requiring a pull request with a code-owner review and the check, the second bypassed by no one (plan section 15,
mitigation 2). Reading the bypass lists needs `Administration: read` on the GitOps App's installation.

| Part                                                        | What                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`gitops`](.github/actions/gitops/action.yml)               | Runs one command from [`src/`](src) through `actions/github-script` with its authenticated Octokit, REST API version `2026-03-10`, retries on transient errors                                                          |
| [`publish-event`](.github/actions/publish-event/action.yml) | Builds the events of a run, keeps them in the run report and sends them to the events queue                                                                                                                             |
| [`setup`](.github/actions/setup/action.yml)                 | Checks out `ai-platform-infra` at a commit, fails fast on `compat.json`, installs Terraform at `.terraform-version` with a provider cache, and the `aip-checks` CLI                                                     |
| [`src/`](src)                                               | The GitOps logic: the admin check, resolving what to apply, preflight (R1) and the ruleset check, the pause gate, submit, events, validation facts, dispatches, the release merge, the major tag and the `autoPin` pins |
| [`scripts/`](scripts)                                       | `apply.sh` (plan, apply, purge, operations, report), `desired-state.sh` (validate, stage, restage), `publish-event.sh`, `setup.sh`, `infra-checks.sh` and `setup/` (repository settings, drift)                         |

Workflows hold no inline logic: parameters reach the modules and scripts as `AIP_*` variables, never by
interpolating an expression into a script. Each job mints its own App token with only the permissions and
repositories it needs (`actions/create-github-app-token`); `submit`'s is `contents: write` on the one state
repository.

## Using them

Callers and composite actions are referenced by major tag, `DEFRA/ai-platform-workflows/...@v2`; every other
action by its major tag too (`actions/checkout@v7`). Dependabot proposes new majors after a seven-day
cooldown. Workflow inputs are the only interface; repository names follow the convention
`{owner}/ai-platform-{name}`. A caller must set `secrets: inherit`: a reusable workflow receives no secrets
otherwise, and each workflow that mints a token declares `GITOPS_APP_PRIVATE_KEY` as a required secret.
`@v1` stays tagged for callers that have not moved (`ai-platform-environments` calls it unchanged: it only
dispatches an apply, as an exempt App).

| Where                      | Variables and secrets                                                                                                                                                                      | Branches |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Secret                     | `GITOPS_APP_PRIVATE_KEY`, the App key, one per repository or an organisation secret                                                                                                        | –        |
| Repository variables       | `GITOPS_APP_CLIENT_ID` and `AZURE_TENANT_ID`, shared by every environment                                                                                                                  | –        |
| Environment `{env}`        | `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID` of `id-aip-deploy-{env}`; `AIP_EVENTS_QUEUE_URL`, `AIP_EVENTS_ROLE_ARN`, `AIP_EVENTS_CLIENT_ID`, `AIP_EVENTS_AUDIENCE`; tenants and deployments | `main`   |
| Environment `{env}-events` | The same four `AIP_EVENTS_*`, and `AIP_PAUSED` (`true` or `false`, created `false`); tenants and deployments                                                                               | `main`   |

Only real environments (`infradev`, `dev`, `test`, `preprod`, `prod`) and their `{env}-events` are GitHub
Environments. The apply jobs use `{env}`, so Azure issues a token only to a job on `main` in the matching
Environment; `submit`, `pause.yml` and the apply's pause gate use `{env}-events`, which has no Azure role. The
events identity (`id-aip-events-{env}`) is federated to both. An Environment variable wins over a repository
variable of the same name. In Phase 1 the one App is `ai-platform-orchestrator`.

Runners: each registry entry's `runner` decides where its apply jobs run, as standard labels
(`["ubuntu-26.04"]`, Phase 1) or a larger-runner group with Azure private networking (`{"group": "aip-{env}"}`,
the target). Changing it is a registry pull request, not a workflow change.

## Repository settings

Direct commits only work if nothing but the submit Apps can bypass the pull-request rule, so every GitOps repository
needs its rulesets. [`scripts/setup/repo-settings.sh`](scripts/setup) applies them idempotently from the JSON in
that folder (`--dry-run` prints the calls; `--verify` is a dry run that also reads the live settings and exits 1
on any difference); design B `#rulesets` is the source.

```sh
scripts/setup/repo-settings.sh --app-id {release App} --submit-app-ids {App},{infradev App} \
  --environments infradev [--admins-team aice-platform-admins] [--dry-run | --verify]
```

| Repositories                          | `main`                                                                                                                                                                                                                                                               | Also                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-platform-tenants`, `-deployments` | `aip-machine-main`: a pull request with one approval and a code-owner review, and the check `validate-desired-state / validate`; squash only; bypassed by the submit Apps alone, which commit directly. `aip-machine-protect`: no force push, no deletion; no bypass | Environments `{env}` and `{env}-events`: `main` only, administrators cannot bypass, every other deployment branch or tag policy removed; `AIP_PAUSED=false` created in `{env}-events`; `aice-platform-admins` repository admin (to set `AIP_PAUSED`) on these two only |
| `ai-platform-infra`, `-workflows`     | Pull request with one approval; the required checks of the PR workflow; squash only; the App bypasses to merge a release PR                                                                                                                                          | Auto-merge allowed; tag ruleset `v*` and branch ruleset `release-please--*` writable by the App only, so a release PR holds only the App's commits                                                                                                                     |
| `ai-platform-environments`            | Pull request with one approval; required check `validate-environments / validate`; squash only                                                                                                                                                                       | –                                                                                                                                                                                                                                                                      |

No administrator, person or team is ever a bypass actor, and the script stops before any write if a body would say
otherwise (plan section 15, mitigations 1 and 6). That is the limit of what it can do: a repository admin can still
delete a ruleset by hand, so `aice-platform-admins` stays small and every such change is detected, not prevented (see
Settings drift). A pull request that changes `.github/` in a state repository needs a code-owner review by
`aice-platform-admins` (the callers' `CODEOWNERS`) and the check, which passes it once it is approved.

A disabled workflow is treated as an engineer's pause: a dispatch to it fails with `workflow-disabled` and
nothing re-enables it. The script lists any disabled workflow it finds.

### Settings drift

[`settings-drift.yml`](.github/workflows/settings-drift.yml) runs `repo-settings.sh --verify` daily, then
[`audit-log.sh`](scripts/setup/audit-log.sh), which lists every ruleset, branch protection, Environment, Actions
settings, collaborator, team access, deploy key and webhook change in the last 26 hours, and fails the run on any
difference or change. It needs a read-only `AIP_SETTINGS_AUDIT_TOKEN` secret and the variables `AIP_RELEASE_APP_ID`,
`AIP_SUBMIT_APP_IDS` and `AIP_ENVIRONMENTS`. An admin's own change, an `AIP_PAUSED` update included, shows too.

## Releases

release-please tags `vX.Y.Z` from conventional commits and moves `vX` through the Git refs API.
`version.txt` is the running version that `setup` compares with an infra release's `compat.json`. The App
has no Workflows permission, so a release never edits `.github/workflows/`. A rerun of a release run that
failed after release-please made the release finds that release and finishes the major tag or the pins.
Only the release App may push to `release-please--branches--main`, and the release merge checks that the App
opened the pull request and wrote every commit on it.

The release workflows use this repository's own actions through `@v2`, so `v2` must exist before the release that
makes `v2.0.0`. Once, right after the pull request that starts v2 merges, point it at `main`; the release then moves
it to `v2.0.0`:

```sh
gh api repos/DEFRA/ai-platform-workflows/git/refs -f ref=refs/tags/v2 \
  -f sha="$(gh api repos/DEFRA/ai-platform-workflows/git/ref/heads/main --jq .object.sha)"
```

`v1` is untouched and stays for callers that have not moved.

## Development

```sh
npm ci
npm run lint
npm test          # unit tests, and the script tests in bash with fake terraform, aws, az, gh and aip-checks
actionlint
shellcheck scripts/*.sh scripts/setup/*.sh
```

The script tests need bash and jq. On Windows set `AIP_TEST_BASH` to Git Bash's `bash.exe`. The tests check every
event `publish-event` builds against a copy of `event.schema.json` from `ai-platform-infra` in
`tests/fixtures/aip-gitops/`; update it when the schema moves. New and changed modules have a coverage floor of 95
(`vitest.config.js`); the global thresholds are unchanged.

Licence: [Open Government Licence v3](LICENCE).
