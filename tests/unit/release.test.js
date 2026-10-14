import { join } from 'node:path'

import nock from 'nock'

import {
  mergeRelease,
  moveMajorTag,
  resolveRelease,
  submitAutoPins
} from '../../src/release.js'
import {
  branchRules,
  checkRuns,
  dispatchedRun,
  fileContent,
  pullRequest
} from '../fixtures/github-api.js'
import {
  INFRA_SHA,
  pin,
  registry,
  registryEntry
} from '../fixtures/gitops-documents.js'
import {
  API,
  commandInput,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA
} from '../helpers/github.js'

const INFRA = `/repos/${OWNER}/ai-platform-infra`
const WORKFLOWS = `/repos/${OWNER}/ai-platform-workflows`
const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`
const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const BRANCH = 'release-please--branches--main'
const HEAD = 'b'.repeat(40)
const REQUIRED = ['infra-checks / validate', 'infra-checks / lint']
const BOT = 'ai-platform-orchestrator[bot]'

describe('mergeRelease', () => {
  function input(run = {}) {
    return commandInput(
      { env: { AIP_APP_SLUG: 'ai-platform-orchestrator' } },
      {
        repo: 'ai-platform-infra',
        eventName: 'workflow_run',
        payload: {
          workflow_run: {
            conclusion: 'success',
            head_branch: BRANCH,
            head_sha: HEAD,
            ...run
          }
        }
      }
    )
  }

  function releasePullRequest(
    pulls = [pullRequest({ head: { ref: BRANCH, sha: HEAD } })]
  ) {
    nock(API)
      .get(`${INFRA}/pulls`)
      .query({ head: `${OWNER}:${BRANCH}`, state: 'open', per_page: '1' })
      .reply(200, pulls)
  }

  function commitsBy(...logins) {
    nock(API)
      .get(`${INFRA}/pulls/7/commits`)
      .query({ per_page: '100' })
      .reply(
        200,
        logins.map((login) => ({ sha: HEAD, author: { login } }))
      )
  }

  function requiredChecks(contexts = REQUIRED) {
    nock(API)
      .get(`${INFRA}/rules/branches/main`)
      .query({ per_page: '100' })
      .reply(200, branchRules(contexts))
  }

  function checksOnHead(runs) {
    nock(API)
      .get(`${INFRA}/commits/${HEAD}/check-runs`)
      .query({ per_page: '100' })
      .reply(200, checkRuns(runs))
  }

  test('merges once every required check passed on the head', async () => {
    releasePullRequest()
    commitsBy(BOT, BOT)
    requiredChecks()
    checksOnHead([
      ['infra-checks / validate', 'completed', 'success'],
      ['infra-checks / lint', 'completed', 'skipped'],
      ['CodeQL', 'in_progress', null]
    ])
    const merged = nock(API)
      .put(`${INFRA}/pulls/7/merge`, { merge_method: 'squash', sha: HEAD })
      .reply(200, { merged: true })

    await expect(mergeRelease(input())).resolves.toEqual({
      outcome: 'merged',
      number: 7
    })
    expect(merged.isDone()).toBe(true)
  })

  test('waits for a required check that has not passed', async () => {
    releasePullRequest()
    commitsBy(BOT)
    requiredChecks()
    checksOnHead([
      ['infra-checks / validate', 'completed', 'success'],
      ['infra-checks / lint', 'completed', 'failure']
    ])
    const merged = nock(API).put(`${INFRA}/pulls/7/merge`).reply(200, {})

    await expect(mergeRelease(input())).resolves.toEqual({
      outcome: 'waiting',
      waiting: ['infra-checks / lint']
    })
    expect(merged.isDone()).toBe(false)
  })

  test('never merges unchecked when main requires no checks', async () => {
    releasePullRequest()
    commitsBy(BOT)
    requiredChecks([])

    await expect(mergeRelease(input())).rejects.toMatchObject({
      outcome: 'not-merged'
    })
  })

  test('leaves a release pull request whose head moved on', async () => {
    releasePullRequest([
      pullRequest({ head: { ref: BRANCH, sha: 'f'.repeat(40) } })
    ])

    await expect(mergeRelease(input())).resolves.toEqual({
      outcome: 'not-merged'
    })
    expect(jobSummary()).toContain('has moved on')
  })

  test('refuses a release pull request a person opened on the release branch', async () => {
    releasePullRequest([
      pullRequest({
        head: { ref: BRANCH, sha: HEAD },
        user: { login: 'someone', type: 'User' }
      })
    ])

    await expect(mergeRelease(input())).rejects.toMatchObject({
      outcome: 'not-merged'
    })
  })

  test('refuses a release pull request with a commit someone else wrote', async () => {
    releasePullRequest()
    commitsBy(BOT, 'someone')

    await expect(mergeRelease(input())).rejects.toMatchObject({
      outcome: 'not-merged',
      message: expect.stringContaining('not written only by the release App')
    })
  })

  test.each([
    [{ conclusion: 'failure' }],
    [{ head_branch: 'feature/x' }],
    [{ head_branch: 'release-please--branches--main-x' }]
  ])('ignores a run that is not a green release (%o)', async (run) => {
    await expect(mergeRelease(input(run))).resolves.toEqual({
      outcome: 'not-a-release'
    })
  })
})

describe('resolveRelease', () => {
  function input(env, attempt = '1') {
    return commandInput(
      { env: { GITHUB_RUN_ATTEMPT: attempt, ...env } },
      { repo: 'ai-platform-infra', eventName: 'push' }
    )
  }

  test('takes the release release-please created', async () => {
    await expect(
      resolveRelease(
        input({ AIP_CREATED: 'true', AIP_TAG: 'v1.4.2', AIP_SHA: HEAD })
      )
    ).resolves.toEqual({ released: true, tag: 'v1.4.2', sha: HEAD })
    expect(exportedVariables()).toEqual({ AIP_TAG: 'v1.4.2', AIP_SHA: HEAD })
  })

  test('finds the release of this commit on a rerun', async () => {
    nock(API)
      .get(`${INFRA}/releases`)
      .query({ per_page: '10' })
      .reply(200, [{ tag_name: 'v1.4.3' }, { tag_name: 'v1.4.2' }])
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv1.4.3`)
      .reply(200, { object: { sha: 'c'.repeat(40) } })
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv1.4.2`)
      .reply(200, { object: { sha: SHA } })

    await expect(
      resolveRelease(input({ AIP_CREATED: 'false' }, '2'))
    ).resolves.toEqual({ released: true, tag: 'v1.4.2', sha: SHA })
    expect(exportedVariables().AIP_TAG).toBe('v1.4.2')
  })

  test.each([
    ['a first attempt with no release', '1', null],
    ['a rerun of a commit with no release', '2', [{ tag_name: 'latest' }]]
  ])('reports no release for %s', async (_, attempt, releases) => {
    // A first attempt never looks: release-please would have reported it.
    if (releases) {
      nock(API).get(`${INFRA}/releases`).query(true).reply(200, releases)
    }

    await expect(
      resolveRelease(input({ AIP_CREATED: 'false' }, attempt))
    ).resolves.toEqual({ released: false })
    expect(exportedVariables()).toEqual({})
  })
})

describe('moveMajorTag', () => {
  function input(env = {}) {
    return commandInput(
      { env: { AIP_TAG: 'v1.4.2', AIP_SHA: HEAD, ...env } },
      { repo: 'ai-platform-workflows' }
    )
  }

  test('moves the major tag to the release commit', async () => {
    const moved = nock(API)
      .patch(`${WORKFLOWS}/git/refs/tags%2Fv1`, { sha: HEAD, force: true })
      .reply(200, {})

    await expect(moveMajorTag(input())).resolves.toEqual({
      major: 'v1',
      sha: HEAD
    })
    expect(moved.isDone()).toBe(true)
    expect(jobSummary()).toContain('Moved v1 to v1.4.2')
  })

  test('creates the major tag at the first release of a major', async () => {
    nock(API).patch(`${WORKFLOWS}/git/refs/tags%2Fv2`).reply(422, {})
    const created = nock(API)
      .post(`${WORKFLOWS}/git/refs`, { ref: 'refs/tags/v2', sha: HEAD })
      .reply(201, {})

    await moveMajorTag(input({ AIP_TAG: 'v2.0.0' }))

    expect(created.isDone()).toBe(true)
  })

  test('refuses a release without a semantic version tag', async () => {
    await expect(
      moveMajorTag(input({ AIP_TAG: 'latest' }))
    ).rejects.toMatchObject({ outcome: 'failed' })
  })
})

describe('submitAutoPins', () => {
  function input() {
    return commandInput(
      {
        env: {
          AIP_TAG: 'v0.5.0',
          AIP_SHA: INFRA_SHA,
          AIP_APP_SLUG: 'ai-platform-orchestrator',
          AIP_CANONICAL_MODULE: join(
            import.meta.dirname,
            '..',
            'fixtures',
            'canonical-json.js'
          )
        }
      },
      { repo: 'ai-platform-infra', eventName: 'push', runId: 98765 }
    )
  }

  test('submits a pin of the release for each autoPin environment', async () => {
    nock(API)
      .get(`${ENVIRONMENTS}/contents/registry.json`)
      .query({ ref: 'main' })
      .reply(
        200,
        fileContent(
          registry([
            registryEntry(),
            registryEntry({ name: 'sandbox' }),
            registryEntry({ name: 'dev', autoPin: false })
          ])
        )
      )
    nock(API)
      .get(`${DEPLOYMENTS}/contents/environments%2Finfradev%2Fplatform.json`)
      .query({ ref: 'main' })
      .reply(200, fileContent(pin()))
    nock(API)
      .get(`${DEPLOYMENTS}/contents/environments%2Fsandbox%2Fplatform.json`)
      .query({ ref: 'main' })
      .reply(404)
    const submitted = []
    nock(API)
      .post(`${DEPLOYMENTS}/actions/workflows/submit.yml/dispatches`, (body) =>
        submitted.push(body.inputs)
      )
      .times(2)
      .reply(200, dispatchedRun(501, 'ai-platform-deployments'))

    await expect(submitAutoPins(input())).resolves.toEqual({
      submitted: ['infradev', 'sandbox']
    })

    const [infradev, sandbox] = submitted
    expect(infradev).toMatchObject({
      action: 'write',
      environment: 'infradev',
      path: 'environments/infradev/platform.json',
      operation_id: 'rel-infradev-v0-5-0-98765',
      requested_by: 'app:ai-platform-orchestrator'
    })
    expect(sandbox.operation_id).toBe('rel-sandbox-v0-5-0-98765')

    const document = JSON.parse(infradev.document)
    expect(document).toMatchObject({
      environment: 'infradev',
      release: 'v0.5.0',
      sha: INFRA_SHA,
      previousRelease: 'v0.4.0',
      operationId: 'rel-infradev-v0-5-0-98765'
    })
    expect(Object.keys(document)).toEqual([...Object.keys(document)].sort())
    expect(infradev.document.endsWith('}\n')).toBe(true)
    expect(JSON.parse(sandbox.document).previousRelease).toBeNull()
  })
})
