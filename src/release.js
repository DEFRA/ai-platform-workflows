import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  dispatchWorkflow,
  gitopsRepo,
  readJson,
  writeSummary
} from './github.js'
import { OutcomeError, pinPath } from './gitops.js'

const RELEASE_BRANCH = 'release-please--branches--main'
const RELEASE_TAG = /^(v\d+)\.\d+\.\d+$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const PASSED = new Set(['success', 'neutral', 'skipped'])

function releaseOf(env) {
  const major = RELEASE_TAG.exec(env.AIP_TAG ?? '')?.[1]

  if (!major || !COMMIT_SHA.test(env.AIP_SHA ?? '')) {
    throw new OutcomeError('failed', 'a release needs a tag vX.Y.Z and a SHA')
  }

  return { tag: env.AIP_TAG, major, sha: env.AIP_SHA }
}

async function requiredChecks(github, { owner, repo }) {
  const rules = await github.paginate(github.rest.repos.getBranchRules, {
    owner,
    repo,
    branch: 'main',
    per_page: 100
  })

  return rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) =>
      rule.parameters.required_status_checks.map((check) => check.context)
    )
}

// The release App opened the pull request and wrote every commit on it, so
// nobody else's change reaches main through the App's bypass. A ruleset lets
// only the App push to the release branch, which makes this unforgeable.
async function writtenByReleaseApp(github, { owner, repo }, pull, slug) {
  const bot = `${slug}[bot]`

  if (pull.user?.type !== 'Bot' || pull.user.login !== bot) {
    return false
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pull.number,
    per_page: 100
  })

  return commits.every((commit) => commit.author?.login === bot)
}

/**
 * merge-release: run when the pull request checks complete. The App merges
 * the open release-please pull request, as the ruleset's bypass actor, once
 * every check main requires has passed on the commit those checks ran on
 * (direction 13 October 2026, 10B), and only when the release App wrote it.
 * Nothing is merged when main requires no checks.
 *
 * Inputs: AIP_APP_SLUG, the release App.
 *
 * @param {object} input - Command context from main.js; `context.payload`
 *   is the workflow_run event.
 * @returns {Promise<{outcome: string, waiting?: string[]}>} Result.
 */
async function mergeRelease({ github, context, core, env }) {
  const { owner, repo } = context.repo
  const run = context.payload.workflow_run

  if (run?.conclusion !== 'success' || run.head_branch !== RELEASE_BRANCH) {
    return { outcome: 'not-a-release' }
  }

  const { data: pulls } = await github.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${run.head_branch}`,
    state: 'open',
    per_page: 1
  })
  const pull = pulls[0]

  if (!pull || pull.head.sha !== run.head_sha) {
    await writeSummary(core, 'not-merged', [
      'The release pull request is closed or has moved on; the checks of its new head merge it.'
    ])
    return { outcome: 'not-merged' }
  }

  if (
    !(await writtenByReleaseApp(github, context.repo, pull, env.AIP_APP_SLUG))
  ) {
    throw new OutcomeError(
      'not-merged',
      `${pull.html_url} was not written only by the release App`
    )
  }

  const required = await requiredChecks(github, context.repo)

  if (required.length === 0) {
    throw new OutcomeError(
      'not-merged',
      'main requires no status checks, so a release is never merged unchecked'
    )
  }

  const checkRuns = await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: run.head_sha,
    per_page: 100
  })
  const waiting = required.filter(
    (name) =>
      !checkRuns.some(
        (check) =>
          check.name === name &&
          check.status === 'completed' &&
          PASSED.has(check.conclusion)
      )
  )

  if (waiting.length > 0) {
    await writeSummary(
      core,
      'waiting',
      waiting.map((name) => `- ${name}`)
    )
    return { outcome: 'waiting', waiting }
  }

  await github.rest.pulls.merge({
    owner,
    repo,
    pull_number: pull.number,
    merge_method: 'squash',
    sha: run.head_sha
  })
  await writeSummary(core, 'merged', [`Release pull request: ${pull.html_url}`])

  return { outcome: 'merged', number: pull.number }
}

/**
 * resolve-release: the release this run made. release-please reports a
 * release only on the run that creates it, so a rerun after a later step
 * failed finds the release whose tag points at this run's commit, and the
 * idempotent steps after it (major tag, pins) run again. Exports AIP_TAG and
 * AIP_SHA when there is a release.
 *
 * Inputs: AIP_CREATED, AIP_TAG and AIP_SHA from release-please;
 * GITHUB_RUN_ATTEMPT.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{released: boolean, tag?: string, sha?: string}>}
 */
async function resolveRelease({ github, context, core, env }) {
  let release = env.AIP_CREATED === 'true' ? releaseOf(env) : null

  if (!release && env.GITHUB_RUN_ATTEMPT !== '1') {
    const { data: releases } = await github.rest.repos.listReleases({
      ...context.repo,
      per_page: 10
    })

    for (const candidate of releases) {
      if (!RELEASE_TAG.test(candidate.tag_name)) {
        continue
      }

      // release-please tags through the releases API: lightweight tags.
      const { data: ref } = await github.rest.git.getRef({
        ...context.repo,
        ref: `tags/${candidate.tag_name}`
      })

      if (ref.object.sha === context.sha) {
        release = releaseOf({
          AIP_TAG: candidate.tag_name,
          AIP_SHA: context.sha
        })
        break
      }
    }
  }

  if (!release) {
    return { released: false }
  }

  core.exportVariable('AIP_TAG', release.tag)
  core.exportVariable('AIP_SHA', release.sha)

  return { released: true, tag: release.tag, sha: release.sha }
}

/**
 * move-major-tag: points the major tag (v1 for v1.4.2) at the release
 * commit through the Git refs API, which needs only contents write.
 *
 * Inputs: AIP_TAG, AIP_SHA.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{major: string, sha: string}>} The tag moved.
 */
async function moveMajorTag({ github, context, core, env }) {
  const { major, sha, tag } = releaseOf(env)

  try {
    await github.rest.git.updateRef({
      ...context.repo,
      ref: `tags/${major}`,
      sha,
      force: true
    })
  } catch (error) {
    if (error.status !== 422) {
      throw error
    }

    await github.rest.git.createRef({
      ...context.repo,
      ref: `refs/tags/${major}`,
      sha
    })
  }

  await writeSummary(core, `Moved ${major} to ${tag}`, [`Commit \`${sha}\`.`])

  return { major, sha }
}

/**
 * submit-auto-pins: after an ai-platform-infra release, submits a pin of
 * the new release for every registry entry with autoPin, through the
 * deployments repository's submit workflow (D9). The pin is serialised by
 * the released checks' canonical-json.js, the bytes submit validates.
 *
 * Inputs: AIP_TAG, AIP_SHA, AIP_APP_SLUG (the pins are requested by
 * app:{slug}), AIP_CANONICAL_MODULE (path of canonical-json.js in the
 * release checkout).
 *
 * @param {object} input - Command context from main.js; `github` reads
 *   ai-platform-environments and ai-platform-deployments and dispatches in
 *   the latter.
 * @returns {Promise<{submitted: string[]}>} The environments pinned.
 */
async function submitAutoPins({ github, context, core, env }) {
  const { tag, sha } = releaseOf(env)
  const { owner } = context.repo
  const requestedBy = `app:${env.AIP_APP_SLUG}`
  const { canonicalJson } = await import(
    pathToFileURL(resolve(env.AIP_CANONICAL_MODULE)).href
  )
  const registry = await readJson(github, {
    ...gitopsRepo(owner, 'environments'),
    path: 'registry.json',
    ref: 'main'
  })
  const deployments = gitopsRepo(owner, 'deployments')
  const submitted = []
  const lines = []

  for (const entry of registry.environments.filter((e) => e.autoPin)) {
    const path = pinPath(entry.name)
    const previous = await readJson(github, {
      ...deployments,
      path,
      ref: 'main'
    })
    // One operation, and so one op/ branch, per environment.
    const operationId = `rel-${entry.name}-${tag.replaceAll('.', '-')}-${context.runId}`
    const pin = {
      schemaVersion: 1,
      environment: entry.name,
      release: tag,
      sha,
      previousRelease: previous?.release ?? null,
      requestedBy,
      operationId,
      requestedAt: new Date().toISOString()
    }
    const url = await dispatchWorkflow(github, {
      ...deployments,
      workflow: 'submit.yml',
      inputs: {
        action: 'write',
        environment: entry.name,
        path,
        document: canonicalJson(pin),
        operation_id: operationId,
        requested_by: requestedBy
      }
    })

    submitted.push(entry.name)
    lines.push(`- \`${entry.name}\` (\`${operationId}\`): ${url ?? 'started'}`)
  }

  await writeSummary(
    core,
    `Pins of ${tag} submitted`,
    lines.length > 0 ? lines : ['No environment has autoPin.']
  )

  return { submitted }
}

export { mergeRelease, moveMajorTag, resolveRelease, submitAutoPins }
