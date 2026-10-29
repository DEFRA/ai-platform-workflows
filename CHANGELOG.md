# Changelog

## [2.0.2](https://github.com/DEFRA/ai-platform-workflows/compare/v2.0.1...v2.0.2) (2026-10-29)


### Bug Fixes

* say which claims the refused events token had ([#22](https://github.com/DEFRA/ai-platform-workflows/issues/22)) ([279c7b0](https://github.com/DEFRA/ai-platform-workflows/commit/279c7b0e90e4cb690c59e969699d6402c60b71db))

## [2.0.1](https://github.com/DEFRA/ai-platform-workflows/compare/v2.0.0...v2.0.1) (2026-10-29)


### Bug Fixes

* check the rulesets' bypass lists only where the token can read them ([#20](https://github.com/DEFRA/ai-platform-workflows/issues/20)) ([8adaa1c](https://github.com/DEFRA/ai-platform-workflows/commit/8adaa1c819e488647b98e1561f265cd93aa08b3a))

## [2.0.0](https://github.com/DEFRA/ai-platform-workflows/compare/v1.1.1...v2.0.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* callers must move to workflows v2. submit-desired-state takes action write, remove or revert (abandon is removed), requires path, and adds cdp_request_id and expected_base. The state repositories' callers move to @v2 in their own pull requests.

### Features

* commit to main directly and send status events (workflows v2) ([#17](https://github.com/DEFRA/ai-platform-workflows/issues/17)) ([75aeb13](https://github.com/DEFRA/ai-platform-workflows/commit/75aeb13f2cddd3627027f503e5c82766e2295677))


### Bug Fixes

* pin the release workflows' own actions to the merge commit until v2 exists ([#18](https://github.com/DEFRA/ai-platform-workflows/issues/18)) ([5788716](https://github.com/DEFRA/ai-platform-workflows/commit/5788716391acef47b1d69c4cdc5d0bc7309f056f))

## [1.1.1](https://github.com/DEFRA/ai-platform-workflows/compare/v1.1.0...v1.1.1) (2026-10-19)


### Bug Fixes

* merge validated pull requests without a person, and add the repository settings script ([#10](https://github.com/DEFRA/ai-platform-workflows/issues/10)) ([b773471](https://github.com/DEFRA/ai-platform-workflows/commit/b773471b4e36841fa4c40fc236a83d2a08517fc4))

## [1.1.0](https://github.com/DEFRA/ai-platform-workflows/compare/v1.0.0...v1.1.0) (2026-10-15)


### Features

* pass team_registrations to the tenants apply ([#8](https://github.com/DEFRA/ai-platform-workflows/issues/8)) ([19ad7b5](https://github.com/DEFRA/ai-platform-workflows/commit/19ad7b56042fd964cf7afb77b4ec3041ef41ae70))

## 1.0.0 (2026-10-15)


### Features

* add the reusable GitOps workflows, actions, modules and scripts ([#1](https://github.com/DEFRA/ai-platform-workflows/issues/1)) ([907d74b](https://github.com/DEFRA/ai-platform-workflows/commit/907d74b14933c99934328422f6c6515ab41e42da))


### Bug Fixes

* ignore the release-please manifest in prettier ([#7](https://github.com/DEFRA/ai-platform-workflows/issues/7)) ([91857b4](https://github.com/DEFRA/ai-platform-workflows/commit/91857b48dc4a14f598177fbcab27bafe602a171e))
* pass secrets to the reusable workflows that mint an App token ([#4](https://github.com/DEFRA/ai-platform-workflows/issues/4)) ([f17c8b4](https://github.com/DEFRA/ai-platform-workflows/commit/f17c8b47abfd0a5d13c0e442eae8ad8bd92c80de))
