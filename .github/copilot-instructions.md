# ai-platform-workflows

Reusable GitHub Actions workflows, composite actions, GitOps modules and scripts used by `ai-platform-infra`, `-environments`, `-tenants` and `-deployments`. Callers pin `@v1`, so a change here reaches all four repositories. Design: README and design B `#workflows`.

## Review first

- **Injection.** Workflows hold no inline logic. Parameters reach scripts and modules as `AIP_*` environment variables, never by interpolating `${{ }}` expressions (inputs, branch names, PR titles, issue text) into a `run` script or `github-script`.
- **Permissions and tokens.** `permissions: {}` at the top, then the least each job needs. Each job mints its own App token scoped to the repositories and permissions it needs. No secret is echoed, logged or written to a report or artifact. A reusable workflow declares `GITOPS_APP_PRIVATE_KEY` as a required secret and callers use `secrets: inherit`.
- **Pinned and boring.** Actions by major tag from a vendor (`actions/*`, `hashicorp/*`, `azure/*`); no unreviewed third-party action. Terraform runs only from `scripts/apply.sh` (deployment) and `scripts/infra-checks.sh` (format, validate, test).
- **Safeguards stay.** Superseded-commit guard, platform-before-tenants, re-validation at the pin, plan-guard, concurrency groups that never cancel an apply, the Entra purge and the run report. Weakening any of them needs a stated reason.
- **Compatibility.** A change callers cannot take unchanged is a new major. `setup` fails fast against `compat.json` in `ai-platform-infra`, which names the oldest release of this repository an infra release works with.

## Conventions

- JavaScript in `src/`: ES modules, named exports, JSDoc on exports, tests in `tests/` (`tests/unit/` for modules, `tests/integration/` for scripts; vitest only discovers `tests/**/*.test.js`). Scripts in `scripts/` are bash with `set -euo pipefail`, shellcheck clean, tested with fake `terraform` and `aip-checks`.
- Workflow inputs are the only interface between caller and workflow. Do not edit `.github/workflows/` through the release App.
- Checks: `npm ci`, `npm run lint`, `npm test`, `actionlint`, `shellcheck scripts/*.sh`. On Windows set `AIP_TEST_BASH` to Git Bash.
- Repository rulesets live in `scripts/setup/`; change the JSON, not the settings by hand.
- Releases are release-please from conventional commits; the `v1` tag moves on release.

## Pull requests

1. Branch `<type>/<description>`; conventional commits (`feat!:` or a `BREAKING CHANGE` footer for a breaking change).
2. Run the checks above before pushing. Say which callers a change reaches and how you tested it.
3. **Request Copilot review**: `gh pr edit <n> --add-reviewer "@copilot"`. Answer every comment, then request a human reviewer. Copilot is advisory and never replaces the required approval.
4. Do not merge your own PR or skip checks.
