import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { writeEnvironmentsConfig, writeSummary } from './github.js'
import {
  environmentName,
  kindOf,
  OutcomeError,
  pinnedRelease
} from './gitops.js'

const ACTIONS = new Set(['write', 'remove', 'abandon'])
const OPERATION_ID = /^[a-z0-9][a-z0-9-]{7,63}$/
const TRACE_PARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
const REQUESTED_BY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REVISION = /^\d+$/
// A dispatch input holds at most 65,535 characters.
const MAX_DOCUMENT_BYTES = 60 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

const CREATE_COMMIT = `
  mutation ($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit { oid }
    }
  }
`

const ENABLE_AUTO_MERGE = `
  mutation ($id: ID!, $headline: String!, $body: String!) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $id
      mergeMethod: SQUASH
      commitHeadline: $headline
      commitBody: $body
    }) {
      pullRequest { number }
    }
  }
`

function branchFor(operationId) {
  return `op/${operationId}`
}

function inputProblem(env) {
  const action = env.AIP_ACTION
  const environment = env.AIP_ENVIRONMENT ?? ''

  if (!ACTIONS.has(action)) {
    return 'action must be write, remove or abandon'
  }

  if (!/^[a-z][a-z0-9]{1,15}$/.test(environment)) {
    return 'invalid environment'
  }

  if (!OPERATION_ID.test(env.AIP_OPERATION_ID ?? '')) {
    return 'invalid operation_id'
  }

  if (env.AIP_TRACE_PARENT && !TRACE_PARENT.test(env.AIP_TRACE_PARENT)) {
    return 'invalid trace_parent'
  }

  if (env.AIP_REQUESTED_BY && !REQUESTED_BY.test(env.AIP_REQUESTED_BY)) {
    return 'requested_by must be an opaque ID'
  }

  if (action === 'abandon') {
    return null
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

  const bytes = Buffer.byteLength(env.AIP_DOCUMENT ?? '')

  if (action === 'write' && (bytes === 0 || bytes >= MAX_DOCUMENT_BYTES)) {
    return 'document must be under 60 KB'
  }

  return null
}

function documentPin(env) {
  try {
    return JSON.parse(env.AIP_DOCUMENT)
  } catch {
    throw new OutcomeError('checks-failed', 'document is not JSON')
  }
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
    `Requested-By: ${requestedBy || 'unknown'}`,
    ...(traceParent ? [`Traceparent: ${traceParent}`] : [])
  ]

  return {
    headline: `chore(${environment}): ${action} ${basename(path, '.json')}`,
    body: trailers.join('\n')
  }
}

async function operationPullRequest(github, { owner, repo }, operationId) {
  const { data } = await github.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branchFor(operationId)}`,
    state: 'all',
    per_page: 10
  })

  return data[0] ?? null
}

async function lockingPullRequest(github, { owner, repo }, path, operationId) {
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100
  })

  for (const pull of pulls) {
    const ref = pull.head.ref

    if (!ref.startsWith('op/') || ref === branchFor(operationId)) {
      continue
    }

    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pull.number,
      per_page: 100
    })

    if (files.some((file) => file.filename === path)) {
      return pull
    }
  }

  return null
}

// No pull request exists for the operation, so a branch left by an earlier
// attempt holds nothing worth keeping: start again from the validated main.
async function pointBranchAt(github, { owner, repo }, branch, sha) {
  try {
    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha
    })
  } catch (error) {
    if (error.status !== 422) {
      throw error
    }

    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha,
      force: true
    })
  }
}

async function reported(core, outcome, pull = null) {
  await writeSummary(
    core,
    outcome,
    pull ? [`Pull request: ${pull.html_url}`] : []
  )

  return pull
    ? { outcome, number: pull.number, url: pull.html_url }
    : { outcome }
}

/**
 * prepare-submit: checks the dispatch inputs, reports an operation that
 * already has a pull request (`existing`, exporting AIP_OUTCOME), and
 * otherwise resolves the release the change is validated at and copies the
 * environment's parameters to AIP_CONFIG. Nothing is written to Git when
 * this fails (`checks-failed`). Exports AIP_KIND, AIP_RELEASE, AIP_SHA and
 * AIP_DOCUMENT_FILE.
 *
 * Inputs: AIP_ACTION, AIP_ENVIRONMENT, AIP_PATH, AIP_DOCUMENT,
 * AIP_OPERATION_ID, AIP_EXPECTED_REVISION, AIP_REQUESTED_BY,
 * AIP_TRACE_PARENT, AIP_CONFIG.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{kind: string, release?: string, sha?: string}>} Result.
 */
async function prepareSubmit({ github, app, context, core, env }) {
  const problem = inputProblem(env)

  if (problem) {
    throw new OutcomeError('checks-failed', problem)
  }

  const kind = kindOf(context.repo.repo)
  core.exportVariable('AIP_KIND', kind)

  if (env.AIP_ACTION === 'abandon') {
    return { kind }
  }

  // Idempotent per operation: a retry after the pull request was raised, or
  // merged, reports it rather than failing on a revision main has moved past.
  const existing = await operationPullRequest(
    github,
    context.repo,
    env.AIP_OPERATION_ID
  )

  if (existing) {
    core.exportVariable('AIP_OUTCOME', 'existing')
    return { kind, ...(await reported(core, 'existing', existing)) }
  }

  const environment = environmentName(env.AIP_ENVIRONMENT)
  const writesPin = kind === 'pins' && env.AIP_ACTION === 'write'
  const { release, sha } = await pinnedRelease({
    github,
    app,
    context,
    kind,
    environment,
    ref: 'main',
    fallback: writesPin ? documentPin(env) : null
  })

  if (env.AIP_ACTION === 'write') {
    const file = join(env.RUNNER_TEMP, 'document.json')
    await writeFile(file, env.AIP_DOCUMENT)
    core.exportVariable('AIP_DOCUMENT_FILE', file)
  }

  await writeEnvironmentsConfig(app, {
    owner: context.repo.owner,
    environments: [environment],
    dir: env.AIP_CONFIG || 'config'
  })
  core.exportVariable('AIP_RELEASE', release)
  core.exportVariable('AIP_SHA', sha)

  return { kind, release, sha }
}

/**
 * submit: writes or removes the validated file on op/{operation} as the App
 * with createCommitOnBranch, opens the pull request, labels it and enables
 * squash auto-merge with the trailers in the squash body. Idempotent per
 * operation: an operation that has a pull request reports it (`existing`).
 * Another operation's open pull request on the same file is `file-locked`.
 *
 * Inputs: AIP_ACTION, AIP_ENVIRONMENT, AIP_PATH, AIP_DOCUMENT,
 * AIP_OPERATION_ID, AIP_REQUESTED_BY, AIP_TRACE_PARENT and AIP_MAIN_SHA, the
 * head of main the change was validated against.
 *
 * @param {object} input - Command context from main.js; `github` is the
 *   writer token.
 * @returns {Promise<{outcome: string, number?: number, url?: string}>}
 */
async function submit({ github, context, core, env }) {
  const { owner, repo } = context.repo
  const operationId = env.AIP_OPERATION_ID
  const path = env.AIP_PATH
  const existing = await operationPullRequest(github, context.repo, operationId)

  if (existing) {
    return reported(core, 'existing', existing)
  }

  const locking = await lockingPullRequest(
    github,
    context.repo,
    path,
    operationId
  )

  if (locking) {
    throw new OutcomeError(
      'file-locked',
      `${path} belongs to the open pull request ${locking.html_url}`
    )
  }

  const branch = branchFor(operationId)
  const message = commitMessage({
    action: env.AIP_ACTION,
    environment: env.AIP_ENVIRONMENT,
    path,
    operationId,
    requestedBy: env.AIP_REQUESTED_BY,
    traceParent: env.AIP_TRACE_PARENT
  })

  await pointBranchAt(github, context.repo, branch, env.AIP_MAIN_SHA)
  await github.graphql(CREATE_COMMIT, {
    input: {
      branch: {
        repositoryNameWithOwner: `${owner}/${repo}`,
        branchName: branch
      },
      message,
      expectedHeadOid: env.AIP_MAIN_SHA,
      fileChanges:
        env.AIP_ACTION === 'write'
          ? {
              additions: [
                {
                  path,
                  contents: Buffer.from(env.AIP_DOCUMENT).toString('base64')
                }
              ]
            }
          : { deletions: [{ path }] }
    }
  })

  const { data: pull } = await github.rest.pulls.create({
    owner,
    repo,
    title: message.headline,
    head: branch,
    base: 'main',
    body:
      `Submitted by the AI Platform for operation \`${operationId}\`.\n\n` +
      `${message.body}\n`,
    maintainer_can_modify: false
  })

  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: pull.number,
    labels: ['gitops', `env:${env.AIP_ENVIRONMENT}`]
  })
  await github.graphql(ENABLE_AUTO_MERGE, {
    id: pull.node_id,
    headline: `${message.headline} (#${pull.number})`,
    body: message.body
  })

  return reported(core, 'pr-raised', pull)
}

/**
 * abandon: closes the operation's open pull request and deletes its branch,
 * releasing the file for the team's next request (R7).
 *
 * Inputs: AIP_OPERATION_ID.
 *
 * @param {object} input - Command context from main.js; `github` is the
 *   writer token.
 * @returns {Promise<{outcome: string, number?: number}>} `abandoned`,
 *   `already-merged` or `nothing-to-abandon`.
 */
async function abandon({ github, context, core, env }) {
  const { owner, repo } = context.repo
  const operationId = env.AIP_OPERATION_ID
  const pull = await operationPullRequest(github, context.repo, operationId)

  if (!pull) {
    return reported(core, 'nothing-to-abandon')
  }

  if (pull.merged_at) {
    return reported(core, 'already-merged', pull)
  }

  if (pull.state === 'open') {
    await github.rest.pulls.update({
      owner,
      repo,
      pull_number: pull.number,
      state: 'closed'
    })
  }

  try {
    await github.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branchFor(operationId)}`
    })
  } catch (error) {
    // Already gone.
    if (error.status !== 422 && error.status !== 404) {
      throw error
    }
  }

  return reported(core, 'abandoned', pull)
}

/**
 * prune: deletes op/* branches whose last commit is older than AIP_DAYS
 * (default 7) and that have no open pull request (R7).
 *
 * @param {object} input - Command context from main.js; `github` needs
 *   contents write.
 * @returns {Promise<{deleted: string[]}>} The branches deleted.
 */
async function prune({ github, context, core, env }) {
  const { owner, repo } = context.repo
  const days = Number(env.AIP_DAYS || 7)

  if (!Number.isInteger(days) || days < 1) {
    throw new OutcomeError('failed', 'days must be a whole number of days')
  }

  const cutoff = Date.now() - days * DAY_MS
  const refs = await github.paginate(github.rest.git.listMatchingRefs, {
    owner,
    repo,
    ref: 'heads/op/'
  })
  const deleted = []

  for (const ref of refs) {
    const branch = ref.ref.slice('refs/heads/'.length)
    const { data: commit } = await github.rest.git.getCommit({
      owner,
      repo,
      commit_sha: ref.object.sha
    })

    if (Date.parse(commit.committer.date) >= cutoff) {
      continue
    }

    const { data: open } = await github.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: 'open',
      per_page: 1
    })

    if (open.length === 0) {
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` })
      deleted.push(branch)
    }
  }

  await writeSummary(
    core,
    'pruned',
    deleted.length > 0 ? deleted.map((branch) => `- \`${branch}\``) : ['None.']
  )

  return { deleted }
}

export { abandon, commitMessage, prepareSubmit, prune, submit }
