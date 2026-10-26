import { writeSummary } from './github.js'
import { environmentName } from './gitops.js'
import { OutcomeError } from './outcome.js'

// The Apps the platform runs as, by exact login (design B `#workflows`).
// github-actions[bot] is deliberately absent: GITHUB_TOKEN can start a
// workflow_dispatch, so it would let any workflow in the organisation in.
const EXEMPT_APPS = new Set([
  'ai-platform-orchestrator[bot]',
  'ai-platform-orchestrator-infradev[bot]',
  'ai-platform-release[bot]'
])
const SCOPES = new Set(['submit', 'apply', 'pause'])
// The caller of the nightly and engineer-dispatched reconcile (DD25); the
// caller file is code-owned, so a branch cannot stand in for it.
const RECONCILE_CALLER = '.github/workflows/reconcile-all.yml@refs/heads/main'

/**
 * Whether a login is one of the exempt Apps.
 *
 * @param {string} login - The actor's login.
 * @returns {boolean} True for an exempt App.
 */
function isExemptApp(login) {
  return EXEMPT_APPS.has(login)
}

// The repository admin role, from the collaborators API, which returns the
// highest role across repository, team, organisation and enterprise grants.
// A bot other than an exempt App cannot hold it, so GitHub is not asked.
async function isAdmin(github, repo, login) {
  if (login.endsWith('[bot]')) {
    return false
  }

  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: login
    })

    return data.role_name === 'admin'
  } catch (error) {
    if (error.status === 404) {
      return false
    }

    throw error
  }
}

async function requireAdmins(github, repo, actors) {
  for (const login of new Set(actors)) {
    if (!(await isAdmin(github, repo, login))) {
      throw new OutcomeError(
        'not-admin',
        `${login} is neither an exempt App nor a repository admin of ${repo.repo}`
      )
    }
  }
}

function isReconcileAll(context, env) {
  const { owner, repo } = context.repo

  return (
    env.AIP_ALL === 'true' &&
    env.AIP_BREAK_GLASS_INPUTS !== 'true' &&
    env.AIP_WORKFLOW_REF === `${owner}/${repo}/${RECONCILE_CALLER}`
  )
}

async function decide({ github, context, env }) {
  const scope = env.AIP_ADMIN_SCOPE
  const actor = env.AIP_ACTOR || context.actor
  const triggering = env.AIP_TRIGGERING_ACTOR || actor
  const breakGlass = env.AIP_BREAK_GLASS_INPUTS === 'true'

  if (context.eventName !== 'workflow_dispatch') {
    return { outcome: 'not-dispatched', actor }
  }

  if (scope === 'apply' && isReconcileAll(context, env)) {
    return { outcome: 'reconcile-all', actor }
  }

  // An App is no admin: break-glass inputs and pause.yml need people. A re-run
  // keeps github.actor's privileges, so whoever re-ran must be an admin too.
  if (breakGlass || scope === 'pause') {
    await requireAdmins(github, context.repo, [actor, triggering])
    return { outcome: 'admin', actor }
  }

  // A portal or release run: the App started it, and an engineer may re-run
  // its failed jobs.
  if (isExemptApp(actor)) {
    return { outcome: 'exempt-app', actor }
  }

  await requireAdmins(github, context.repo, [actor, triggering])

  return { outcome: 'admin', actor }
}

/**
 * admin-check: the first step of a dispatched workflow, before any token is
 * minted or anything changed (AC18). Only `workflow_dispatch` is checked;
 * a push or a schedule is not. An exempt App's dispatch passes; anyone else
 * needs the repository admin role, and for a hand write (an actor that is
 * not an exempt App), `pause.yml` and the apply's `allow_destroy` or
 * `force_unlock` both `github.actor` and `github.triggering_actor` need it.
 * An engineer's `reconcile-all` from main of its code-owned caller, with
 * `all` true and no break-glass inputs, is exempt.
 *
 * Inputs: AIP_ADMIN_SCOPE (submit, apply or pause), AIP_ENVIRONMENT (checked
 * when given), AIP_ACTOR,
 * AIP_TRIGGERING_ACTOR, AIP_BREAK_GLASS_INPUTS (`true` when allow_destroy or
 * force_unlock is given), AIP_ALL, AIP_WORKFLOW_REF.
 *
 * @param {object} input - Command context from main.js; `github` needs
 *   metadata read on this repository.
 * @returns {Promise<{outcome: string, actor: string}>} Why it passed.
 */
async function adminCheck(input) {
  if (!SCOPES.has(input.env.AIP_ADMIN_SCOPE)) {
    throw new OutcomeError('failed', 'admin-check needs a scope')
  }

  // A job that names `{environment}-events` makes GitHub create the
  // Environment if it is missing, so the name is checked before any job does.
  if (input.env.AIP_ENVIRONMENT) {
    environmentName(input.env.AIP_ENVIRONMENT)
  }

  const result = await decide(input)

  await writeSummary(input.core, `Access: ${result.outcome}`, [
    `\`${result.actor}\` ran this as a \`${input.context.eventName}\`.`
  ])

  return result
}

export { adminCheck, EXEMPT_APPS, isExemptApp }
