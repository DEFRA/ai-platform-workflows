# ai-platform-workflows

Reusable GitHub Actions workflows, composite actions, GitOps modules and scripts used by `ai-platform-infra`, `-environments`, `-tenants` and `-deployments`. Callers pin a major tag (`@v2`; `@v1` stays tagged), so every minor and patch release reaches all four repositories automatically; only a new major is a deliberate, reviewed move for them. Design: README and design B `#workflows`.

## Review first

- **Injection.** Workflows hold no inline logic. Parameters reach scripts and modules as `AIP_*` environment variables, never by interpolating `${{ }}` expressions (inputs, branch names, PR titles, issue text) into a `run` script or `github-script`.
- **Permissions and tokens.** `permissions: {}` at the top, then the least each job needs. Each job mints its own App token scoped to the repositories and permissions it needs. No secret is echoed, logged or written to a report or artifact. A reusable workflow declares `GITOPS_APP_PRIVATE_KEY` as a required secret and callers use `secrets: inherit`.
- **Pinned and boring.** Actions by major tag from a vendor (`actions/*`, `hashicorp/*`, `azure/*`); no unreviewed third-party action. Terraform runs only from `scripts/apply.sh` (deployment) and `scripts/infra-checks.sh` (format, validate, test).
- **Who may run it, and what it says.** The first job of `submit`, the apply and `pause.yml` is the admin check (exempt Apps by exact login, never `github-actions[bot]`; both `github.actor` and `github.triggering_actor` for a hand write, pause and break-glass inputs). A run sends its status through `publish-event`, which must never fail a deploy. `submit` commits to `main` with `expectedHeadOid`; there is no pull request.
- **Safeguards stay.** Superseded-commit guard, platform-before-tenants, re-validation at the pin, plan-guard, concurrency groups that never cancel an apply, the Entra purge and the run report. Weakening any of them needs a stated reason.
- **Versioning.** Callers pin a major, so the release type is a contract. A fix is a patch, a backwards-compatible feature a minor, and anything callers cannot take unchanged (an input, output, secret, permission or behaviour change) a new major (`feat!:` or a `BREAKING CHANGE` footer). Check the PR is classified honestly and was tested against what each caller passes today. `setup` fails fast against `compat.json` in `ai-platform-infra`, which names the oldest release of this repository an infra release works with.

## Conventions

- JavaScript in `src/`: ES modules, named exports, JSDoc on exports, tests in `tests/` (`tests/unit/` for modules, `tests/integration/` for scripts; vitest only discovers `tests/**/*.test.js`). Scripts in `scripts/` are bash with `set -euo pipefail`, shellcheck clean, tested with fake `terraform` and `aip-checks`.
- Workflow inputs are the only interface between caller and workflow. Do not edit `.github/workflows/` through the release App.
- Checks: `npm ci`, `npm run lint`, `npm test`, `actionlint`, `shellcheck scripts/*.sh scripts/setup/*.sh`. On Windows set `AIP_TEST_BASH` to Git Bash.
- Repository rulesets live in `scripts/setup/`; change the JSON, not the settings by hand.
- Releases are release-please from conventional commits; the major tag (`v2`) moves on release.

## Pull requests

1. Branch `<type>/<description>`; conventional commits (`feat!:` or a `BREAKING CHANGE` footer for a breaking change).
2. Run the checks above before pushing. Say which callers a change reaches and how you tested it.
3. **Request Copilot review**: `gh pr edit <n> --add-reviewer "@copilot"`. When it lands, fix every comment or reply with the reason it does not apply, push, then resolve each thread (GraphQL `resolveReviewThread`); re-request after a substantial push and repeat until nothing is unresolved. Then request a human reviewer. Copilot is advisory and never replaces the required approval.
4. Do not merge your own PR or skip checks.
