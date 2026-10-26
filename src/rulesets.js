import { OutcomeError } from './outcome.js'

const MAIN = 'aip-machine-main'
const PROTECT = 'aip-machine-protect'
// The Apps that run `submit`, and so the only actors allowed to bypass the
// pull-request rule of aip-machine-main (design B `#rulesets`).
const SUBMIT_APPS = [
  'ai-platform-orchestrator',
  'ai-platform-orchestrator-infradev'
]

function changed(message) {
  return new OutcomeError('rulesets-changed', message)
}

async function submitAppIds(github) {
  const ids = []

  for (const slug of SUBMIT_APPS) {
    try {
      const { data } = await github.rest.apps.getBySlug({ app_slug: slug })
      ids.push(data.id)
    } catch (error) {
      // An App that is not there bypasses nothing, so nothing is expected.
      if (error.status !== 404) {
        throw error
      }
    }
  }

  return ids
}

function ruleOf(ruleset, type) {
  return ruleset.rules?.find((rule) => rule.type === type)
}

function checkMain(ruleset, appIds) {
  const bypass = ruleset.bypass_actors

  if (!Array.isArray(bypass)) {
    throw changed(
      `${MAIN} has no bypass list the token can read; the App needs Administration: read on this repository`
    )
  }

  const stray = bypass.find(
    (actor) =>
      actor.actor_type !== 'Integration' ||
      actor.bypass_mode !== 'always' ||
      !appIds.includes(actor.actor_id)
  )

  if (stray || bypass.length === 0) {
    throw changed(
      `${MAIN} has a bypass list that is not the submit Apps alone: ${JSON.stringify(
        bypass.map(({ actor_type: type, actor_id: id, bypass_mode: mode }) => ({
          type,
          id,
          mode
        }))
      )}`
    )
  }

  const review = ruleOf(ruleset, 'pull_request')?.parameters

  if (!(
    review?.required_approving_review_count >= 1 &&
    review.require_code_owner_review
  )) {
    throw changed(
      `${MAIN} no longer requires a pull request with a code-owner review`
    )
  }

  if (!ruleOf(ruleset, 'required_status_checks')) {
    throw changed(`${MAIN} no longer requires a status check`)
  }
}

function checkProtect(ruleset) {
  if (
    !Array.isArray(ruleset.bypass_actors) ||
    ruleset.bypass_actors.length > 0
  ) {
    throw changed(`${PROTECT} has a bypass list; it must have none`)
  }

  if (!ruleOf(ruleset, 'deletion') || !ruleOf(ruleset, 'non_fast_forward')) {
    throw changed(`${PROTECT} no longer blocks force pushes and deletion`)
  }
}

/**
 * The apply's ruleset check (mitigation 2, plan §15): the state repository
 * has the active repository rulesets `aip-machine-main` and
 * `aip-machine-protect`, the first bypassed by the submit Apps alone and
 * still requiring a pull request with a code-owner review and the check, the
 * second by no one and still blocking force pushes and deletion. Anything
 * else stops the apply before it runs as the deploy identity, because a
 * repository admin who can relax these can commit to main without review
 * (accepted residual risk, §15; this makes it noticed, not impossible).
 *
 * Reading `bypass_actors` needs Administration: read on the token.
 *
 * @param {object} github - Client with that read; the App's.
 * @param {{owner: string, repo: string}} repository - The state repository.
 * @returns {Promise<void>} Resolves when the rulesets are as expected.
 * @throws {OutcomeError} `rulesets-changed` when they are not.
 */
async function verifyRulesets(github, { owner, repo }) {
  if (!github) {
    throw new OutcomeError('failed', 'the ruleset check needs an App token')
  }

  const rulesets = await github.paginate(github.rest.repos.getRepoRulesets, {
    owner,
    repo,
    includes_parents: false,
    per_page: 100
  })
  const found = {}

  for (const name of [MAIN, PROTECT]) {
    found[name] = rulesets.find(
      (ruleset) => ruleset.name === name && ruleset.source_type === 'Repository'
    )

    if (!found[name]) {
      throw changed(`${name} is missing from ${repo}`)
    }
  }

  const detail = {}

  for (const name of [MAIN, PROTECT]) {
    const { data } = await github.rest.repos.getRepoRuleset({
      owner,
      repo,
      ruleset_id: found[name].id
    })

    if (data.enforcement !== 'active') {
      throw changed(`${name} is not active in ${repo}`)
    }

    detail[name] = data
  }

  checkMain(detail[MAIN], await submitAppIds(github))
  checkProtect(detail[PROTECT])
}

export { verifyRulesets }
