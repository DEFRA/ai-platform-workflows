import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { writeSummary } from './github.js'
import { resourcesOf } from './resources.js'

const EVENT_SCHEMA = 'aip.gitops.event/1'
// From these on, an event says which commit it is about and when it was made.
const COMMIT_STATUSES = new Set(['committed', 'deploying', 'deployed'])
const STATUSES = new Set([
  'requested',
  'checks-failed',
  'committed',
  'deploying',
  'deployed',
  'deploy-failed',
  'paused',
  'resumed'
])
// The codes a failure event may call retryable (contract C4): the backend
// resubmits or defers these instead of ending the operation.
const RETRYABLE = {
  'checks-failed': new Set(['stale-revision', 'paused', 'commit-conflict']),
  'deploy-failed': new Set(['paused'])
}
const APPLY_FAILED = 'The apply failed; the run has the details.'
const MAX_MESSAGE = 500
// The time reporting may take in all (AIP_PUBLISH_SECONDS): the lookups here
// and the send in scripts/publish-event.sh share it.
const DEFAULT_PUBLISH_SECONDS = 10
const PRINCIPAL_APP = /^[a-z][a-z0-9-]{0,38}$/
const USER_ID = /^[1-9][0-9]{0,19}$/

/**
 * One identity for whoever started a run that names no requester, in the
 * form the contract uses: app:{name} for an App or github:{user ID}.
 *
 * @param {string} login - The actor's login.
 * @param {string} id - The actor's numeric ID.
 * @returns {string} The principal.
 */
function principalOf(login, id) {
  if (login.endsWith('[bot]') && PRINCIPAL_APP.test(login.slice(0, -5))) {
    return `app:${login.slice(0, -5)}`
  }

  if (login && !login.endsWith('[bot]') && USER_ID.test(id)) {
    return `github:${id}`
  }

  throw new Error('cannot name the actor as one identity')
}

function idsOf(value) {
  const text = (value ?? '').trim()

  if (text.startsWith('[')) {
    return JSON.parse(text)
  }

  return text.split(/[\s,]+/).filter(Boolean)
}

// What an event is about: an operation, a commit nobody asked the platform
// for (break-glass), or nothing but the environment (a run with no operation,
// or a pause). The report's commits carry the operation IDs of the trailers.
function unitsOf(ids, report) {
  const commits = report?.operations ?? []

  if (ids.length > 0) {
    return ids.map((operationId) => ({
      operationId,
      commit: commits.find((commit) =>
        commit.operationIds?.includes(operationId)
      )
    }))
  }

  const units = commits.flatMap((commit) =>
    commit.operationIds.length > 0
      ? commit.operationIds.map((operationId) => ({ operationId, commit }))
      : [{ operationId: null, commit, breakGlass: true }]
  )

  return units.length > 0 ? units : [{ operationId: null }]
}

function failureReason(status, failure, report) {
  if (status !== 'checks-failed' && status !== 'deploy-failed') {
    return null
  }

  const code = failure?.code || status
  const message =
    failure?.message ||
    (status === 'deploy-failed'
      ? APPLY_FAILED
      : 'The change failed its checks.')

  return {
    code,
    message: message.slice(0, MAX_MESSAGE),
    retryable: RETRYABLE[status].has(code)
  }
}

// The commit an event is about. A run that applies a commit no operation
// names (a manual apply, reconcile-all) is about the commit it applied.
function commitShaOf({ commit, operationId }, facts, report) {
  if (commit) {
    return commit.sha
  }

  if (facts.source === 'apply' && !operationId) {
    return report?.appliedSha
  }

  return facts.commitSha || undefined
}

// The one team file an operation's commit changed in the environment. An
// apply learns it from the commit, because the report names only the commit.
function teamFileOf(environment, files = []) {
  const prefix = `environments/${environment}/`
  const found = files.filter(
    (file) =>
      file.startsWith(prefix) &&
      file.endsWith('.json') &&
      !file.slice(prefix.length).includes('/')
  )

  return found.length === 1 ? found[0] : null
}

function eventFor(unit, status, facts, extras) {
  const { commit, operationId } = unit
  const commitSha = commitShaOf(unit, facts, extras.report)
  const known = extras.commits[commitSha] ?? {}
  const committedAt =
    known.committedAt ??
    (commitSha === facts.commitSha ? facts.committedAt : undefined)
  // A break-glass event names the pull request that carried the commit; a
  // manual commit with none is reported as the apply it is.
  const pullRequestUrl = unit.breakGlass
    ? extras.pullRequests?.[commitSha]
    : null
  const breakGlass = Boolean(unit.breakGlass && pullRequestUrl)
  const path = operationId
    ? facts.path || teamFileOf(facts.environment, known.files)
    : null

  if (operationId && !path) {
    throw new Error(`cannot name the team file of operation ${operationId}`)
  }

  const needsCommit = COMMIT_STATUSES.has(status) || breakGlass

  if (needsCommit && !(commitSha && committedAt)) {
    throw new Error(
      `cannot say when the commit of ${operationId ?? facts.environment} was made`
    )
  }

  if (status === 'deployed' && !extras.report?.appliedSha) {
    throw new Error('the run report has no appliedSha for the deployed event')
  }

  const groupId =
    operationId ??
    (facts.source === 'apply' && commitSha ? commitSha : facts.environment)
  const eventId = `${groupId}:${status}:${facts.runId}:${facts.runAttempt}`
  const reason = failureReason(status, extras.failure, extras.report)
  const failed = status === 'deploy-failed'
  const team = path ? basename(path, '.json') : null

  return {
    groupId,
    deduplicationId: eventId,
    body: {
      schema: EVENT_SCHEMA,
      eventId,
      environment: facts.environment,
      team,
      path,
      action: breakGlass ? 'break-glass' : facts.action,
      status,
      timestamp: extras.now.toISOString(),
      source: facts.source,
      requestedBy: facts.requestedBy,
      repository: facts.repository,
      traceparent: commit?.traceparent || facts.traceparent || null,
      cdpRequestId: facts.cdpRequestId || null,
      operationId,
      runId: facts.runId,
      runAttempt: facts.runAttempt,
      runUrl: facts.runUrl,
      // The commit and its time travel together (a schema rule).
      ...(commitSha && committedAt && { commitSha, committedAt }),
      ...(breakGlass && { pullRequestUrl }),
      ...(reason && { failureReason: reason }),
      ...(status === 'deployed' && {
        appliedSha: extras.report.appliedSha,
        resources: resourcesOf(extras.report, team)
      }),
      ...(failed && {
        failingTeams: extras.report?.failingTeams ?? [],
        // Only the operation of a team that failed is to blame for it; a
        // failure no team accounts for belongs to no operation.
        attributable:
          extras.report?.unattributedFailure === false &&
          (extras.report.failingTeams ?? []).includes(team)
      })
    }
  }
}

/**
 * The events a run sends for one status: one per operation, per break-glass
 * commit, or one for the environment when the run has neither. Each carries
 * what the SQS FIFO queue needs, the group and the deduplication ID.
 *
 * @param {object} input - What the events are about.
 * @param {string} input.status - A contract status.
 * @param {string[]} [input.ids] - Operation IDs; empty reads them from the
 *   report's commits.
 * @param {object} [input.report] - The run report.
 * @param {{code?: string, message?: string}} [input.failure] - Why.
 * @param {object} input.facts - The run and its environment.
 * @param {Record<string, string>} [input.pullRequests] - Pull request URL
 *   by break-glass commit.
 * @param {Record<string, {committedAt: string, files: string[]}>} [input.commits]
 *   - What GitHub says of each commit an apply names: when it was made and
 *   the files it changed, which give the team file of an operation.
 * @param {Date} [input.now] - The time stamped on the events.
 * @returns {Array<{groupId: string, deduplicationId: string, body: object}>}
 */
function buildEvents({
  status,
  ids = [],
  report = null,
  failure = null,
  facts,
  pullRequests = {},
  commits = {},
  now = new Date()
}) {
  if (!STATUSES.has(status)) {
    throw new Error(`unknown event status ${status}`)
  }

  return unitsOf(ids, report).map((unit) =>
    eventFor(unit, status, facts, {
      failure,
      report,
      pullRequests,
      commits,
      now
    })
  )
}

/**
 * Adds events to the `events[]` of a run report, creating a report that holds
 * only them when there is none, once per event ID. Events are kept with the
 * run before they are sent, so one that cannot be sent is not lost.
 *
 * @param {string} file - The report's path.
 * @param {Array<{body: object}>} events - From buildEvents.
 * @returns {void}
 */
function recordEvents(file, events) {
  let report = {}

  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  const kept = report.events ?? []
  const known = new Set(kept.map((event) => event.eventId))
  const added = events
    .map(({ body }) => body)
    .filter((body) => !known.has(body.eventId))

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ ...report, events: [...kept, ...added] }, null, 2)}\n`
  )
}

async function pullRequestsOf(github, repo, report, signal) {
  const found = {}

  for (const commit of report?.operations ?? []) {
    if (commit.operationIds.length > 0) {
      continue
    }

    try {
      const { data } =
        await github.rest.repos.listPullRequestsAssociatedWithCommit({
          ...repo,
          commit_sha: commit.sha,
          request: { signal }
        })

      found[commit.sha] = data[0]?.html_url ?? null
    } catch {
      // A commit with no link is reported as the apply it is, but not
      // because the time ran out: buildEvent checks the deadline after.
      found[commit.sha] = null
    }
  }

  return found
}

// The time and the files of each commit an apply names, which the run report
// does not hold: the team file tells whose operation it was, the time is the
// `committedAt` the schema requires from `committed` onwards. A commit that
// cannot be read fails the build, so nothing invalid is sent.
async function commitsOf(github, repo, ids, report, facts, signal) {
  if (facts.source !== 'apply') {
    return {}
  }

  const shas = new Set(
    unitsOf(ids, report)
      .map((unit) => commitShaOf(unit, facts, report))
      .filter(Boolean)
  )
  const found = {}

  for (const sha of shas) {
    const { data } = await github.rest.repos.getCommit({
      ...repo,
      ref: sha,
      request: { signal }
    })

    found[sha] = {
      committedAt: data.commit.committer.date,
      files: (data.files ?? []).map((file) => file.filename)
    }
  }

  return found
}

function factsOf(context, env) {
  const { owner, repo } = context.repo
  const source = env.AIP_EVENT_SOURCE
  const runId = context.runId
  const own = source === 'submit' && env.AIP_REQUESTER

  return {
    environment: env.AIP_ENVIRONMENT,
    source,
    action:
      source === 'submit'
        ? env.AIP_ACTION
        : source === 'pause'
          ? 'pause'
          : 'apply',
    path: source === 'submit' ? env.AIP_PATH : '',
    requestedBy:
      own || principalOf(context.actor ?? '', env.GITHUB_ACTOR_ID ?? ''),
    traceparent: env.AIP_TRACE_PARENT,
    cdpRequestId: env.AIP_CDP_REQUEST_ID,
    commitSha: env.AIP_COMMIT_SHA,
    committedAt: env.AIP_COMMITTED_AT,
    repository: `${owner}/${repo}`,
    runId,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    runUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${runId}`
  }
}

/**
 * build-event: the first half of the publish-event action. Builds the events
 * for one status, keeps them in the run report (`AIP_EVENT_REPORT`, created
 * with only `events[]` when the run has none), and writes the messages to
 * send, which it names in AIP_EVENT_FILE. It never fails the run: a problem
 * is a warning and AIP_EVENT_FILE is empty, so nothing is sent.
 *
 * Inputs: AIP_EVENT_STATUS, AIP_EVENT_SOURCE (submit, apply or pause),
 * AIP_EVENT_OPERATION_IDS (empty reads them from the report),
 * AIP_EVENT_REPORT, AIP_EVENT_FAILURE_CODE, AIP_EVENT_FAILURE_MESSAGE,
 * AIP_EVENT_OUT, AIP_ENVIRONMENT, and for a submit AIP_ACTION, AIP_PATH,
 * AIP_REQUESTER, AIP_TRACE_PARENT, AIP_CDP_REQUEST_ID, AIP_COMMIT_SHA and
 * AIP_COMMITTED_AT. The lookups of the apply's commits and pull requests
 * share one deadline with the send (AIP_PUBLISH_SECONDS, 10): a request that
 * outlives it is aborted, nothing is built and a warning says so. On success
 * it exports AIP_EVENT_DEADLINE (epoch seconds), which `publish-event.sh`
 * keeps to.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{events: number}>} How many events were built.
 */
async function buildEvent({ github, context, core, env }) {
  const out = env.AIP_EVENT_OUT || join(env.RUNNER_TEMP, 'aip-events.json')
  const seconds = Number(env.AIP_PUBLISH_SECONDS) || DEFAULT_PUBLISH_SECONDS
  const deadline = Date.now() + seconds * 1000
  const signal = AbortSignal.timeout(seconds * 1000)

  try {
    const report = readReport(env.AIP_EVENT_REPORT)
    const ids = idsOf(env.AIP_EVENT_OPERATION_IDS)
    const facts = factsOf(context, env)
    const commits = await commitsOf(
      github,
      context.repo,
      ids,
      report,
      facts,
      signal
    )
    const pullRequests = await pullRequestsOf(
      github,
      context.repo,
      ids.length === 0 ? report : null,
      signal
    )

    // A lookup that ran out of time is not an answer: an unread pull
    // request would pass a break-glass change off as an ordinary apply.
    signal.throwIfAborted()

    const events = buildEvents({
      status: env.AIP_EVENT_STATUS,
      ids,
      report,
      failure: {
        code: env.AIP_EVENT_FAILURE_CODE,
        message: env.AIP_EVENT_FAILURE_MESSAGE
      },
      facts,
      commits,
      pullRequests
    })

    if (env.AIP_EVENT_REPORT) {
      recordEvents(env.AIP_EVENT_REPORT, events)
    }

    writeFileSync(out, JSON.stringify(events))
    core.exportVariable('AIP_EVENT_FILE', out)
    core.exportVariable(
      'AIP_EVENT_DEADLINE',
      String(Math.ceil(deadline / 1000))
    )

    return { events: events.length }
  } catch (error) {
    const reason = signal.aborted
      ? `GitHub did not answer within the ${seconds} seconds reporting may take`
      : error.message

    core.warning(`publish-event built nothing: ${reason}`)
    await writeSummary(core, 'publish-event', [reason])
    core.exportVariable('AIP_EVENT_FILE', '')

    return { events: 0 }
  }
}

function readReport(file) {
  if (!file) {
    return null
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export { buildEvent, buildEvents, principalOf, recordEvents }
