import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { configDir, writeEnvironmentsConfig, writeSummary } from './github.js'
import {
  environmentName,
  kindOf,
  OutcomeError,
  pinnedRelease
} from './gitops.js'
import { heldBack } from './pause.js'

const ACTIONS = new Set(['write', 'remove', 'revert'])
const OPERATION_ID = /^[a-z0-9][a-z0-9-]{7,63}$/
const TRACE_PARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
const CDP_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
// One identity, never a name or an email address (contract: traceability).
const PRINCIPAL =
  /^(entra:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|github:[1-9][0-9]{0,19}|app:[a-z][a-z0-9-]{0,38})$/
const REVISION = /^\d+$/
// The pin file's blob SHA on main, or 0 when the file is new.
const BASE = /^([0-9a-f]{40}|0)$/
// A dispatch input holds at most 65,535 characters.
const MAX_DOCUMENT_BYTES = 60 * 1024
const MAX_COMMIT_ATTEMPTS = 3
const HISTORY_DEPTH = 30
const OPERATION_ID_LINE = /^Operation-Id:[ \t]*(\S+)[ \t]*$/gim
const RESTAGED_HEAD = /^main-sha=([0-9a-f]{40})$/m
// desired-state.sh exits with this when the base the request names is stale.
const STALE_EXIT = 3

const CREATE_COMMIT = `
  mutation ($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit { oid }
    }
  }
`

// Real time and a real script run; tests inject their own.
const TIMERS = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // One to three seconds, so two submissions that collided do not collide again.
  jitter: () => 1000 + Math.floor(Math.random() * 2001)
}

function runScript(command, args, options) {
  return spawnSync(command, args, options)
}

function inputProblem(env, kind) {
  const action = env.AIP_ACTION
  const environment = env.AIP_ENVIRONMENT ?? ''

  if (!ACTIONS.has(action)) {
    return 'action must be write, remove or revert'
  }

  if (!/^[a-z][a-z0-9]{1,15}$/.test(environment)) {
    return 'invalid environment'
  }

  if (env.AIP_TRACE_PARENT && !TRACE_PARENT.test(env.AIP_TRACE_PARENT)) {
    return 'invalid trace_parent'
  }

  if (env.AIP_CDP_REQUEST_ID && !CDP_REQUEST_ID.test(env.AIP_CDP_REQUEST_ID)) {
    return 'invalid cdp_request_id'
  }

  if (env.AIP_REQUESTED_BY && !PRINCIPAL.test(env.AIP_REQUESTED_BY)) {
    return 'requested_by must be entra:{object ID}, github:{user ID} or app:{name}'
  }

  if (
    !new RegExp(`^environments/${environment}/[a-z0-9-]+\\.json$`).test(
      env.AIP_PATH ?? ''
    )
  ) {
    return `path must be environments/${environment}/{name}.json`
  }

  if (!REVISION.test(env.AIP_EXPECTED_REVISION ?? '')) {
    return 'expected_revision must be a whole number'
  }

  return baseProblem(env, kind) ?? documentProblem(env)
}

// Every write names its base: the revision of a team file, the blob SHA of
// the pin file (AC20).
function baseProblem(env, kind) {
  const base = env.AIP_EXPECTED_BASE ?? ''

  if (kind === 'tenants' && base) {
    return 'expected_base is for the platform pin only; a team file names expected_revision'
  }

  if (kind === 'pins' && !BASE.test(base)) {
    return "expected_base must be the pin file's blob SHA on main, or 0 for a new file"
  }

  return null
}

function documentProblem(env) {
  const bytes = Buffer.byteLength(env.AIP_DOCUMENT ?? '')

  if (
    env.AIP_ACTION !== 'remove' &&
    (bytes === 0 || bytes >= MAX_DOCUMENT_BYTES)
  ) {
    return 'document must be under 60 KB'
  }

  return null
}

function parsedDocument(env) {
  try {
    return JSON.parse(env.AIP_DOCUMENT)
  } catch {
    throw new OutcomeError('checks-failed', 'document is not JSON')
  }
}

/**
 * Who a change is attributed to. The workflow's own App dispatches for the
 * Portal API and the release, which name the signed-in person or the
 * automation in requested_by; anyone else who dispatches is recorded by the
 * GitHub user ID the run was authenticated as, whatever requested_by says.
 *
 * @param {object} [sender] - The dispatch event's sender.
 * @param {object} env - AIP_APP_SLUG and AIP_REQUESTED_BY.
 * @returns {string} The principal.
 */
function requesterOf(sender, env) {
  if (!sender?.id) {
    throw new OutcomeError('checks-failed', 'the run has no sender')
  }

  if (sender.type !== 'Bot' || sender.login !== `${env.AIP_APP_SLUG}[bot]`) {
    return `github:${sender.id}`
  }

  if (!env.AIP_REQUESTED_BY) {
    throw new OutcomeError('checks-failed', 'requested_by is required')
  }

  return env.AIP_REQUESTED_BY
}

// A portal or release run names its operation; a hand run makes its own from
// the run, and may not name one, so nobody can write under an operation the
// Portal API is waiting for.
function operationIdOf(hand, env, context) {
  const named = env.AIP_OPERATION_ID_INPUT ?? ''

  if (!hand) {
    if (!OPERATION_ID.test(named)) {
      throw new OutcomeError('checks-failed', 'invalid operation_id')
    }

    return named
  }

  if (named) {
    throw new OutcomeError(
      'checks-failed',
      'a hand run makes its own operation ID; leave operation_id empty'
    )
  }

  return `hand-${context.runId}`
}

/**
 * The commit headline and body for a submission. The trailers link the
 * commit to the Portal API operation and, when given, its trace.
 *
 * @param {object} input - Submission facts.
 * @returns {{headline: string, body: string}} Commit message parts.
 */
function commitMessage({
  action,
  environment,
  path,
  operationId,
  requestedBy,
  traceParent
}) {
  const trailers = [
    `Operation-Id: ${operationId}`,
    `Requested-By: ${requestedBy}`,
    ...(traceParent ? [`Traceparent: ${traceParent}`] : [])
  ]

  return {
    headline: `chore(${environment}): ${action} ${basename(path, '.json')}`,
    body: trailers.join('\n')
  }
}

// The commit on main that carries the operation's trailer, if an earlier run
// already made it, so a repeat dispatch commits and validates nothing.
async function commitOf(github, { owner, repo }, path, operationId) {
  const { data } = await github.rest.repos.listCommits({
    owner,
    repo,
    sha: 'main',
    path,
    per_page: HISTORY_DEPTH
  })

  return (
    data.find((entry) =>
      [...entry.commit.message.matchAll(OPERATION_ID_LINE)].some(
        (line) => line[1] === operationId
      )
    ) ?? null
  )
}

/**
 * prepare-submit: checks the dispatch inputs, attributes the change
 * (AIP_REQUESTER, which the document's updatedBy or requestedBy must equal),
 * names the operation (a hand run makes its own), holds an App's write while
 * the environment is paused, reports an operation that already committed
 * (`existing`, exporting AIP_OUTCOME), and otherwise resolves the release the
 * change is validated at and copies the environment's parameters to
 * AIP_CONFIG. Nothing is written to Git. Exports AIP_KIND, AIP_OPERATION_ID,
 * AIP_REQUESTER, AIP_RELEASE, AIP_SHA and AIP_DOCUMENT_FILE.
 *
 * Inputs: AIP_ACTION, AIP_ENVIRONMENT, AIP_PATH, AIP_DOCUMENT,
 * AIP_OPERATION_ID_INPUT, AIP_EXPECTED_REVISION, AIP_EXPECTED_BASE,
 * AIP_REQUESTED_BY, AIP_TRACE_PARENT, AIP_CDP_REQUEST_ID, AIP_PAUSED,
 * AIP_APP_SLUG, AIP_CONFIG.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{kind: string, operationId: string, release?: string,
 *   sha?: string, outcome?: string, commit?: string}>} Result.
 */
async function prepareSubmit({ github, app, context, core, env }) {
  const kind = kindOf(context.repo.repo)
  const problem = inputProblem(env, kind)

  if (problem) {
    throw new OutcomeError('checks-failed', problem)
  }

  const { sender } = context.payload
  const requester = requesterOf(sender, env)
  const operationId = operationIdOf(
    requester.startsWith('github:'),
    env,
    context
  )

  // Named before anything can refuse, so the refusal's event can name them.
  core.exportVariable('AIP_KIND', kind)
  core.exportVariable('AIP_OPERATION_ID', operationId)
  core.exportVariable('AIP_REQUESTER', requester)

  if (
    heldBack({
      paused: env.AIP_PAUSED,
      eventName: context.eventName,
      actor: sender.login
    })
  ) {
    throw new OutcomeError(
      'paused',
      `${env.AIP_ENVIRONMENT} is paused; an admin must resume it`
    )
  }

  const committed = await commitOf(
    github,
    context.repo,
    env.AIP_PATH,
    operationId
  )

  if (committed) {
    core.exportVariable('AIP_OUTCOME', 'existing')
    core.exportVariable('AIP_COMMIT_SHA', committed.sha)
    core.exportVariable('AIP_COMMITTED_AT', committed.commit.committer.date)
    await writeSummary(core, 'existing', [`Commit: \`${committed.sha}\``])

    return { kind, operationId, outcome: 'existing', commit: committed.sha }
  }

  const document = env.AIP_ACTION === 'remove' ? null : parsedDocument(env)
  const attribution = kind === 'pins' ? 'requestedBy' : 'updatedBy'

  if (document && document[attribution] !== requester) {
    throw new OutcomeError(
      'checks-failed',
      `${attribution} must be ${requester}, who requested the change`
    )
  }

  const environment = environmentName(env.AIP_ENVIRONMENT)
  const { release, sha } = await pinnedRelease({
    github,
    app,
    context,
    kind,
    environment,
    ref: 'main',
    fallback: kind === 'pins' ? document : null
  })

  if (document) {
    const file = join(env.RUNNER_TEMP, 'document.json')
    await writeFile(file, env.AIP_DOCUMENT)
    core.exportVariable('AIP_DOCUMENT_FILE', file)
  }

  await writeEnvironmentsConfig(app, {
    owner: context.repo.owner,
    environments: [environment],
    dir: configDir(env)
  })
  core.exportVariable('AIP_RELEASE', release)
  core.exportVariable('AIP_SHA', sha)

  return { kind, operationId, release, sha }
}

function headMoved(error) {
  return (error.errors ?? []).some(
    (item) =>
      item.type === 'STALE_DATA' ||
      /expected branch to point to/i.test(item.message ?? '')
  )
}

// Stages and validates the change again on the new head of main, as
// desired-state.sh does for the first attempt. Its exit code says why not.
async function restage({ github, env, run }) {
  const { token } = await github.auth()
  const result = run(
    'bash',
    [`${env.AIP_SCRIPTS}/desired-state.sh`, 'restage'],
    {
      env: { ...process.env, ...env, AIP_GIT_TOKEN: token },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )

  if (result.status === STALE_EXIT) {
    throw new OutcomeError(
      'stale-revision',
      'main moved, and the file is no longer at the base the request names'
    )
  }

  if (result.status !== 0) {
    throw new OutcomeError(
      'checks-failed',
      'the change failed validation on the new head of main; the log has the reasons'
    )
  }

  const head = RESTAGED_HEAD.exec(result.stdout)?.[1]

  if (!head) {
    throw new OutcomeError(
      'failed',
      'the restage did not report the head of main'
    )
  }

  return head
}

/**
 * submit: commits the validated file to main as the App with
 * createCommitOnBranch and `expectedHeadOid`, so it lands on the head it was
 * validated against or not at all, as a signed commit with the Operation-Id,
 * Requested-By and Traceparent trailers. No pull request. When the head has
 * moved it stages and validates again on the new head (desired-state.sh
 * restage), after one to three seconds, up to 3 attempts, then ends with
 * `commit-conflict`, which is sent as a retryable `checks-failed` like
 * `stale-revision` (and kept in the run report for the reconciler), so the
 * backend resubmits it. A restage that finds the base stale ends `stale-revision`.
 * Exports AIP_COMMIT_SHA and AIP_COMMITTED_AT.
 *
 * Inputs: AIP_ACTION, AIP_ENVIRONMENT, AIP_PATH, AIP_DOCUMENT,
 * AIP_OPERATION_ID, AIP_REQUESTER, AIP_TRACE_PARENT, AIP_MAIN_SHA (the head
 * of main the change was validated on), AIP_SCRIPTS.
 *
 * @param {object} input - Command context from main.js; `github` is the
 *   writer token; `timers` (sleep, jitter) and `run` default to real ones.
 * @returns {Promise<{outcome: string, commit: string}>} The commit made.
 */
async function submit(input) {
  const { github, context, core, env } = input
  const timers = {
    sleep: input.timers?.sleep ?? TIMERS.sleep,
    jitter: input.timers?.jitter ?? TIMERS.jitter
  }
  const run = input.run ?? runScript
  const { owner, repo } = context.repo
  const message = commitMessage({
    action: env.AIP_ACTION,
    environment: env.AIP_ENVIRONMENT,
    path: env.AIP_PATH,
    operationId: env.AIP_OPERATION_ID,
    requestedBy: env.AIP_REQUESTER,
    traceParent: env.AIP_TRACE_PARENT
  })
  const fileChanges =
    env.AIP_ACTION === 'remove'
      ? { deletions: [{ path: env.AIP_PATH }] }
      : {
          additions: [
            {
              path: env.AIP_PATH,
              contents: Buffer.from(env.AIP_DOCUMENT).toString('base64')
            }
          ]
        }
  let head = env.AIP_MAIN_SHA
  let commit

  for (let attempt = 1; !commit; attempt += 1) {
    try {
      const result = await github.graphql(CREATE_COMMIT, {
        input: {
          branch: {
            repositoryNameWithOwner: `${owner}/${repo}`,
            branchName: 'main'
          },
          message,
          expectedHeadOid: head,
          fileChanges
        }
      })

      commit = result.createCommitOnBranch.commit.oid
    } catch (error) {
      if (!headMoved(error)) {
        throw error
      }

      if (attempt === MAX_COMMIT_ATTEMPTS) {
        throw new OutcomeError(
          'commit-conflict',
          `main moved on ${MAX_COMMIT_ATTEMPTS} attempts; the reconciler dispatches again`
        )
      }

      await timers.sleep(timers.jitter())
      head = await restage({ github, env, run })
    }
  }

  core.exportVariable('AIP_COMMIT_SHA', commit)
  core.exportVariable('AIP_COMMITTED_AT', new Date().toISOString())
  await writeSummary(core, 'committed', [`Commit: \`${commit}\``])

  return { outcome: 'committed', commit }
}

export { commitMessage, prepareSubmit, runScript, submit, TIMERS }
