## What and why

<!-- Link the plan or issue. -->

## Evidence

- [ ] `npm run lint`, `npm test`, `actionlint` and `shellcheck scripts/*.sh` pass
- [ ] Callers reached (infra, environments, tenants, deployments) and how it was tested
- [ ] No `${{ }}` expression interpolated into a script; permissions no wider than needed
- [ ] Breaking change for callers: `feat!:` or a `BREAKING CHANGE` footer

## Review

- [ ] Copilot review requested (`gh pr edit <n> --add-reviewer "@copilot"`), every comment fixed or answered, every thread resolved
- [ ] Human reviewer requested
