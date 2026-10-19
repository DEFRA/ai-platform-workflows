import { gitopsRepo, readJson, verifyRelease } from './github.js'
import { OutcomeError } from './outcome.js'

const ENVIRONMENT_NAME = /^[a-z][a-z0-9]{1,15}$/
const KINDS = {
  'ai-platform-tenants': 'tenants',
  'ai-platform-deployments': 'pins'
}

/**
 * A registry entry name, checked before it reaches a path or an API call.
 *
 * @param {string} value - Candidate name.
 * @returns {string} The name.
 */
function environmentName(value) {
  if (!ENVIRONMENT_NAME.test(value ?? '')) {
    throw new OutcomeError('checks-failed', `invalid environment ${value}`)
  }

  return value
}

/**
 * What a state repository holds: team files or platform pins.
 *
 * @param {string} repo - Repository name.
 * @returns {'tenants' | 'pins'} The kind.
 */
function kindOf(repo) {
  const kind = KINDS[repo]

  if (!kind) {
    throw new OutcomeError(
      'checks-failed',
      'this runs only in ai-platform-tenants or ai-platform-deployments'
    )
  }

  return kind
}

/**
 * Where an environment's platform pin lives in ai-platform-deployments.
 *
 * @param {string} environment - Registry entry name.
 * @returns {string} Repository-relative path.
 */
function pinPath(environment) {
  return `environments/${environment}/platform.json`
}

/**
 * The ai-platform-infra release a state change is validated at: the
 * environment's pin on main of ai-platform-deployments. A pin change is
 * validated at the release the environment runs before it (the pin at
 * `ref`), and an environment's first pin at its own release (`fallback`).
 *
 * @param {object} input - Clients and location.
 * @param {object} input.github - Client for this repository.
 * @param {object} input.app - App client for the other GitOps repositories.
 * @param {object} input.context - The workflow run context.
 * @param {'tenants' | 'pins'} input.kind - This repository's kind.
 * @param {string} input.environment - Registry entry name.
 * @param {string} [input.ref] - Where to read a pin in this repository.
 * @param {object | null} [input.fallback] - The pin being added.
 * @returns {Promise<{release: string, sha: string}>} The verified release.
 */
async function pinnedRelease({
  github,
  app,
  context,
  kind,
  environment,
  ref,
  fallback = null
}) {
  const { owner } = context.repo
  const pin =
    kind === 'pins'
      ? ((await readJson(github, {
          ...context.repo,
          path: pinPath(environment),
          ref
        })) ?? fallback)
      : await readJson(app, {
          ...gitopsRepo(owner, 'deployments'),
          path: pinPath(environment),
          ref: 'main'
        })

  if (!pin) {
    throw new OutcomeError(
      'checks-failed',
      `${environment} has no platform pin yet`
    )
  }

  await verifyRelease(app, owner, pin)

  return { release: pin.release, sha: pin.sha }
}

export { environmentName, kindOf, OutcomeError, pinnedRelease, pinPath }
