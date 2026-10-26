import {
  changedPaths,
  dispatchWorkflow,
  folderExists,
  gitopsRepo,
  headOfMain,
  includesCommit,
  lastApplied,
  latestDeployment,
  readJson,
  verifyRelease,
  writeEnvironmentsConfig,
  writeSummary
} from './github.js'
import { environmentName, OutcomeError, pinPath } from './gitops.js'
import { verifyRulesets } from './rulesets.js'

const STATES = new Set(['platform', 'tenants'])
const TARGETS = new Set(['tenants', 'deployments'])

function stateOf(value) {
  if (!STATES.has(value)) {
    throw new OutcomeError('failed', 'state must be platform or tenants')
  }

  return value
}

/**
 * Where an environment's apply jobs run, from its registry entry: standard
 * runner labels in Phase 1, a larger-runner group with Azure private
 * networking in the target.
 *
 * @param {{runner: {labels?: string[], group?: string}}} entry - Registry entry.
 * @returns {string} JSON for `runs-on`.
 */
function runnerFor(entry) {
  return JSON.stringify(
    entry.runner.group ? { group: entry.runner.group } : entry.runner.labels
  )
}

async function changedSinceApplied(github, context, environment) {
  const folder = `environments/${environment}`
  const base = await lastApplied(github, { ...context.repo, environment })

  if (!base) {
    return folderExists(github, {
      ...context.repo,
      path: folder,
      ref: context.sha
    })
  }

  const paths = await changedPaths(github, {
    ...context.repo,
    base,
    head: context.sha
  })

  return paths === null || paths.some((path) => path.startsWith(`${folder}/`))
}

// R5: the platform's latest apply succeeded, at the pin's commit or a
// later one.
async function platformApplied(app, owner, environment) {
  const deployments = gitopsRepo(owner, 'deployments')
  const { data: commits } = await app.rest.repos.listCommits({
    ...deployments,
    path: pinPath(environment),
    sha: 'main',
    per_page: 1
  })
  const latest = await latestDeployment(app, { ...deployments, environment })

  if (!commits[0] || !latest?.succeeded) {
    return false
  }

  return includesCommit(app, {
    ...deployments,
    base: commits[0].sha,
    head: latest.sha
  })
}

async function legFor({ github, app, context, core, state, entry, forced }) {
  const { owner, repo } = context.repo
  const name = entry.name
  const pin =
    state === 'platform'
      ? await readJson(github, {
          owner,
          repo,
          path: pinPath(name),
          ref: context.sha
        })
      : await readJson(app, {
          ...gitopsRepo(owner, 'deployments'),
          path: pinPath(name),
          ref: 'main'
        })

  if (!pin) {
    core.notice(
      `${name} has no platform pin yet, so there is nothing to apply.`
    )
    return null
  }

  await verifyRelease(app, owner, pin)

  if (!forced && !(await changedSinceApplied(github, context, name))) {
    return null
  }

  if (state === 'tenants' && !(await platformApplied(app, owner, name))) {
    core.notice(
      `The platform apply of ${name} at ${pin.release} has not succeeded yet; ` +
        'it dispatches this workflow when it does (R5).'
    )
    return null
  }

  return {
    environment: name,
    runner: runnerFor(entry),
    entra_enabled: entry.entra.enabled,
    team_registrations:
      entry.entra.enabled && entry.entra.teamRegistrations !== false,
    release: pin.release,
    sha: pin.sha
  }
}

/**
 * resolve-apply: which environments this run applies, as the apply matrix,
 * with their parameters copied to `AIP_CONFIG` for the apply jobs. A run whose
 * commit is no longer the head of main applies nothing (R1); the run for the
 * head does. A dispatch applies the environment it names; a push applies
 * every environment whose folder changed since its last successful apply,
 * so a superseded run's changes are never lost; `all` (reconcile-all)
 * applies every environment from main, as a dispatch does for one. Tenants
 * apply only once the platform apply covers the environment's pin (R5).
 *
 * Inputs: AIP_STATE, AIP_ENVIRONMENT (dispatch only), AIP_ALL (`true` for
 * every environment; not with AIP_ENVIRONMENT), AIP_CONFIG.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{matrix: object[]}>} The apply matrix.
 */
async function resolveApply({ github, app, context, core, env }) {
  const state = stateOf(env.AIP_STATE)
  const requested = env.AIP_ENVIRONMENT
    ? environmentName(env.AIP_ENVIRONMENT)
    : null
  const all = env.AIP_ALL === 'true'

  if (all && requested) {
    throw new OutcomeError(
      'failed',
      'all applies every environment; it takes no environment'
    )
  }

  const head = await headOfMain(github, context.repo)

  if (head !== context.sha) {
    core.notice(
      `${context.sha} is superseded by ${head} on main; the run for ${head} applies it (R1).`
    )
    return { matrix: [] }
  }

  const { owner } = context.repo
  const registry = await readJson(app, {
    ...gitopsRepo(owner, 'environments'),
    path: 'registry.json',
    ref: 'main'
  })
  const matrix = []

  for (const name of requested
    ? [requested]
    : registry.environments.map((e) => e.name)) {
    const entry = registry.environments.find((e) => e.name === name)

    if (!entry) {
      throw new OutcomeError('failed', `${name} is not in the registry`)
    }

    const leg = await legFor({
      github,
      app,
      context,
      core,
      state,
      entry,
      forced: Boolean(requested) || all
    })

    if (leg) {
      matrix.push(leg)
    }
  }

  if (matrix.length > 0) {
    await writeEnvironmentsConfig(app, {
      owner,
      environments: matrix.map((leg) => leg.environment),
      dir: env.AIP_CONFIG || 'config'
    })
  }

  await writeSummary(
    core,
    `${state} apply`,
    matrix.length > 0
      ? matrix.map((leg) => `- \`${leg.environment}\` at \`${leg.release}\``)
      : ['Nothing to apply.']
  )

  return { matrix }
}

/**
 * preflight: the apply job's first step. Refuses a run whose commit is no
 * longer the head of main, which is how a re-run of an old run is refused
 * (R1), and one whose state repository no longer has the machine rulesets
 * as the design has them (`rulesets-changed`, mitigation 2). Exports
 * AIP_BASE, the commit of the environment's last successful apply, for
 * plan-guard and the run report.
 *
 * Inputs: AIP_ENVIRONMENT.
 *
 * @param {object} input - Command context from main.js; `app` is a token for
 *   this repository with Administration: read.
 * @returns {Promise<{base: string | null}>} The last applied commit.
 */
async function preflight({ github, app, context, core, env }) {
  const environment = environmentName(env.AIP_ENVIRONMENT)
  const head = await headOfMain(github, context.repo)

  if (head !== context.sha) {
    throw new OutcomeError(
      'superseded',
      `This run's commit ${context.sha} is no longer the head of main (${head}). ` +
        'Re-runs are refused (R1); dispatch a fresh run.'
    )
  }

  await verifyRulesets(app, context.repo)

  const base = await lastApplied(github, { ...context.repo, environment })
  core.exportVariable('AIP_BASE', base ?? '')

  return { base }
}

/**
 * dispatch-apply: starts `apply.yml` on main of ai-platform-{AIP_TARGET} for
 * each environment, recording every run started in the job summary.
 *
 * Inputs: AIP_TARGET (tenants or deployments), AIP_ENVIRONMENTS (JSON
 * array), AIP_REASON.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{runs: Array<{environment: string, url: string | null}>}>}
 */
async function dispatchApply({ github, context, core, env }) {
  if (!TARGETS.has(env.AIP_TARGET)) {
    throw new OutcomeError('failed', 'target must be tenants or deployments')
  }

  const target = gitopsRepo(context.repo.owner, env.AIP_TARGET)
  const runs = []

  for (const environment of JSON.parse(env.AIP_ENVIRONMENTS).map(
    environmentName
  )) {
    const url = await dispatchWorkflow(github, {
      ...target,
      workflow: 'apply.yml',
      inputs: { environment, reason: env.AIP_REASON ?? '' }
    })
    runs.push({ environment, url })
  }

  await writeSummary(
    core,
    `Dispatched the ${env.AIP_TARGET} apply`,
    runs.map(
      ({ environment, url }) => `- \`${environment}\`: ${url ?? 'started'}`
    )
  )

  return { runs }
}

export { dispatchApply, preflight, resolveApply, runnerFor }
