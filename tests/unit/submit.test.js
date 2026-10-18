import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import {
  abandon,
  commitMessage,
  prepareSubmit,
  prune,
  submit,
  VALIDATE_CHECK
} from '../../src/submit.js'
import {
  fileContent,
  gitCommit,
  gitRef,
  matchingRef,
  pullRequest,
  pullRequestFile
} from '../fixtures/github-api.js'
import { INFRA_SHA, pin } from '../fixtures/gitops-documents.js'
import {
  API,
  commandInput,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA
} from '../helpers/github.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const OPERATION = '000000000000000000000001'
const PATH = 'environments/infradev/alpha.json'
const PERSON = 'entra:0f8fad5b-d9cb-469f-a165-70867728950e'
const DOCUMENT = `{\n  "revision": 2,\n  "updatedBy": "${PERSON}"\n}\n`
// The workflow's own App dispatched the run, for the Portal API.
const BY_APP = {
  payload: {
    sender: { type: 'Bot', login: 'ai-platform-orchestrator[bot]', id: 9 }
  }
}
const BY_ENGINEER = {
  payload: { sender: { type: 'User', login: 'someone', id: 583231 } }
}

function submission(env = {}) {
  return {
    AIP_ACTION: 'write',
    AIP_ENVIRONMENT: 'infradev',
    AIP_PATH: PATH,
    AIP_DOCUMENT: DOCUMENT,
    AIP_OPERATION_ID: OPERATION,
    AIP_EXPECTED_REVISION: '1',
    AIP_REQUESTED_BY: PERSON,
    AIP_REQUESTER: PERSON,
    AIP_APP_SLUG: 'ai-platform-orchestrator',
    AIP_TRACE_PARENT: '',
    AIP_MAIN_SHA: SHA,
    AIP_CONFIG: join(process.env.RUNNER_TEMP, 'config'),
    RUNNER_TEMP: process.env.RUNNER_TEMP,
    ...env
  }
}

function environmentsRepo() {
  for (const path of [
    'registry.json',
    'global.tfvars.json',
    'environments%2Finfradev%2Fplatform.tfvars.json'
  ]) {
    nock(API)
      .get(`${ENVIRONMENTS}/contents/${path}`)
      .query({ ref: 'main' })
      .reply(200, fileContent('{}\n'))
  }
}

function tagResolves() {
  nock(API).get(`${INFRA}/git/ref/tags%2Fv0.4.0`).reply(200, gitRef(INFRA_SHA))
}

function noOperationPullRequest(repo = TENANTS) {
  nock(API)
    .get(`${repo}/pulls`)
    .query({ head: `${OWNER}:op/${OPERATION}`, state: 'all', per_page: '10' })
    .reply(200, [])
}

// GitHub echoes the title and body it was sent; a new pull request has no
// labels and no auto-merge.
function pullRequestCreated(number, matches = () => true) {
  let sent

  return nock(API)
    .post(`${TENANTS}/pulls`, (body) => {
      sent = body
      return matches(body)
    })
    .reply(201, () =>
      pullRequest({ number, title: sent.title, body: sent.body, labels: [] })
    )
}

function openPullRequests(pulls) {
  nock(API)
    .get(`${TENANTS}/pulls`)
    .query({ state: 'open', per_page: '100' })
    .reply(200, pulls)
}

describe('commitMessage', () => {
  test('carries the operation, requester and trace as trailers', () => {
    expect(
      commitMessage({
        action: 'write',
        environment: 'infradev',
        path: PATH,
        operationId: OPERATION,
        requestedBy: PERSON,
        traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      })
    ).toEqual({
      headline: 'chore(infradev): write alpha',
      body:
        `Operation-Id: ${OPERATION}\nRequested-By: ${PERSON}\n` +
        'Traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    })
  })

  test('omits the trace trailer without a traceparent', () => {
    expect(
      commitMessage({
        action: 'remove',
        environment: 'infradev',
        path: PATH,
        operationId: OPERATION,
        requestedBy: 'app:ai-platform-backend'
      }).body
    ).toBe(`Operation-Id: ${OPERATION}\nRequested-By: app:ai-platform-backend`)
  })
})

describe('prepareSubmit', () => {
  test.each([
    [{ AIP_ACTION: 'merge' }, 'action must be write, remove or abandon'],
    [{ AIP_ENVIRONMENT: 'Infradev' }, 'invalid environment'],
    [{ AIP_OPERATION_ID: 'short' }, 'invalid operation_id'],
    [{ AIP_TRACE_PARENT: 'trace' }, 'invalid trace_parent'],
    [
      { AIP_REQUESTED_BY: 'someone@defra.gov.uk' },
      'requested_by must be entra:{object ID}, github:{user ID} or app:{name}'
    ],
    [
      { AIP_PATH: 'environments/sandbox/alpha.json' },
      'path must be environments/infradev/{name}.json'
    ],
    [
      { AIP_PATH: '../README.md' },
      'path must be environments/infradev/{name}.json'
    ],
    [
      { AIP_EXPECTED_REVISION: '-1' },
      'expected_revision must be a whole number'
    ],
    [{ AIP_DOCUMENT: '' }, 'document must be under 60 KB'],
    [{ AIP_DOCUMENT: 'x'.repeat(61440) }, 'document must be under 60 KB']
  ])('refuses %o before writing anything', async (env, message) => {
    await expect(
      prepareSubmit(commandInput({ env: submission(env) }))
    ).rejects.toMatchObject({ outcome: 'checks-failed', message })
  })

  test('refuses to run outside a state repository', async () => {
    await expect(
      prepareSubmit(
        commandInput({ env: submission() }, { repo: 'ai-platform-infra' })
      )
    ).rejects.toMatchObject({ outcome: 'checks-failed' })
  })

  test('resolves a team file at the environment pin and stages its inputs', async () => {
    noOperationPullRequest()
    nock(API)
      .get(`${DEPLOYMENTS}/contents/environments%2Finfradev%2Fplatform.json`)
      .query({ ref: 'main' })
      .reply(200, fileContent(pin()))
    tagResolves()
    environmentsRepo()

    await expect(
      prepareSubmit(commandInput({ env: submission() }, BY_APP))
    ).resolves.toEqual({ kind: 'tenants', release: 'v0.4.0', sha: INFRA_SHA })

    const exported = exportedVariables()
    expect(exported).toMatchObject({
      AIP_KIND: 'tenants',
      AIP_REQUESTER: PERSON,
      AIP_RELEASE: 'v0.4.0',
      AIP_SHA: INFRA_SHA
    })
    expect(readFileSync(exported.AIP_DOCUMENT_FILE, 'utf8')).toBe(DOCUMENT)
  })

  test("validates an environment's first pin at its own release", async () => {
    noOperationPullRequest(DEPLOYMENTS)
    nock(API)
      .get(`${DEPLOYMENTS}/contents/environments%2Finfradev%2Fplatform.json`)
      .query({ ref: 'main' })
      .reply(404)
    tagResolves()
    environmentsRepo()

    await expect(
      prepareSubmit(
        commandInput(
          {
            env: submission({
              AIP_PATH: 'environments/infradev/platform.json',
              AIP_DOCUMENT: JSON.stringify(pin()),
              AIP_REQUESTED_BY: 'app:ai-platform-orchestrator'
            })
          },
          { repo: 'ai-platform-deployments', ...BY_APP }
        )
      )
    ).resolves.toEqual({ kind: 'pins', release: 'v0.4.0', sha: INFRA_SHA })
  })

  test('refuses a pin document that is not JSON', async () => {
    noOperationPullRequest(DEPLOYMENTS)

    await expect(
      prepareSubmit(
        commandInput(
          {
            env: submission({
              AIP_PATH: 'environments/infradev/platform.json',
              AIP_DOCUMENT: '{ not json'
            })
          },
          { repo: 'ai-platform-deployments', ...BY_APP }
        )
      )
    ).rejects.toMatchObject({ message: 'document is not JSON' })
  })

  test('records an engineer who dispatches by their GitHub user ID, whatever requested_by says', async () => {
    noOperationPullRequest()
    nock(API)
      .get(`${DEPLOYMENTS}/contents/environments%2Finfradev%2Fplatform.json`)
      .query({ ref: 'main' })
      .reply(200, fileContent(pin()))
    tagResolves()
    environmentsRepo()
    const document = DOCUMENT.replace(PERSON, 'github:583231')

    await prepareSubmit(
      commandInput({ env: submission({ AIP_DOCUMENT: document }) }, BY_ENGINEER)
    )

    expect(exportedVariables().AIP_REQUESTER).toBe('github:583231')
  })

  test.each([
    [
      BY_ENGINEER,
      {},
      'updatedBy must be github:583231, who requested the change'
    ],
    [BY_APP, { AIP_REQUESTED_BY: '' }, 'requested_by is required'],
    [{}, {}, 'the run has no sender']
  ])('refuses a change it cannot attribute (%#)', async (run, env, message) => {
    noOperationPullRequest()

    await expect(
      prepareSubmit(commandInput({ env: submission(env) }, run))
    ).rejects.toMatchObject({ outcome: 'checks-failed', message })
  })

  test('reports the pull request a retried operation already has', async () => {
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query(true)
      .reply(200, [pullRequest({ state: 'closed', merged_at: '2026-10-14' })])

    await expect(
      prepareSubmit(commandInput({ env: submission() }))
    ).resolves.toEqual({
      kind: 'tenants',
      outcome: 'existing',
      number: 7,
      url: 'https://github.com/DEFRA/ai-platform-tenants/pull/7'
    })
    expect(exportedVariables()).toEqual({
      AIP_KIND: 'tenants',
      AIP_OUTCOME: 'existing'
    })
    expect(jobSummary()).toContain('### existing')
  })

  test('asks the next steps to complete a retried operation whose pull request is open', async () => {
    nock(API).get(`${TENANTS}/pulls`).query(true).reply(200, [pullRequest()])

    await prepareSubmit(commandInput({ env: submission() }))

    expect(exportedVariables()).toMatchObject({
      AIP_OUTCOME: 'existing',
      AIP_REPAIR: 'true'
    })
    expect(jobSummary()).toContain('### existing')
  })

  test('needs no pin to abandon', async () => {
    await expect(
      prepareSubmit(
        commandInput({
          env: submission({ AIP_ACTION: 'abandon', AIP_PATH: '' })
        })
      )
    ).resolves.toEqual({ kind: 'tenants' })
  })
})

describe('submit', () => {
  test('reports the pull request an operation already has', async () => {
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query(true)
      .reply(200, [pullRequest({ auto_merge: { merge_method: 'squash' } })])

    await expect(submit(commandInput({ env: submission() }))).resolves.toEqual({
      outcome: 'existing',
      number: 7,
      url: 'https://github.com/DEFRA/ai-platform-tenants/pull/7'
    })
    expect(jobSummary()).toContain('### existing')
  })

  test('completes the labels and auto-merge an earlier attempt left undone', async () => {
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query(true)
      .reply(200, [
        pullRequest({
          title: 'chore(infradev): write alpha',
          body: `Submitted by the AI Platform.\n\nOperation-Id: ${OPERATION}\n`,
          labels: [{ name: 'gitops' }]
        })
      ])
    const labels = nock(API)
      .post(`${TENANTS}/issues/7/labels`, { labels: ['env:infradev'] })
      .reply(200, [])
    const autoMerge = nock(API)
      .post(
        '/graphql',
        ({ variables }) =>
          variables.headline === 'chore(infradev): write alpha (#7)' &&
          variables.body === `Operation-Id: ${OPERATION}`
      )
      .reply(200, { data: { enablePullRequestAutoMerge: {} } })

    await expect(
      submit(commandInput({ env: submission() }))
    ).resolves.toMatchObject({ outcome: 'existing', number: 7 })
    expect(labels.isDone()).toBe(true)
    expect(autoMerge.isDone()).toBe(true)
  })

  test('refuses a file another operation has open', async () => {
    noOperationPullRequest()
    openPullRequests([
      pullRequest({ number: 9, head: { ref: 'op/other-operation-1' } })
    ])
    nock(API)
      .get(`${TENANTS}/pulls/9/files`)
      .query(true)
      .reply(200, [pullRequestFile(PATH)])

    await expect(
      submit(commandInput({ env: submission() }))
    ).rejects.toMatchObject({
      outcome: 'file-locked',
      message: `${PATH} belongs to the open pull request https://github.com/DEFRA/ai-platform-tenants/pull/7`
    })
  })

  test('commits as the App, opens the pull request and enables auto-merge', async () => {
    noOperationPullRequest()
    openPullRequests([
      pullRequest({ number: 9, head: { ref: 'op/other-operation-1' } }),
      pullRequest({ number: 10, head: { ref: 'renovate/deps' } })
    ])
    nock(API)
      .get(`${TENANTS}/pulls/9/files`)
      .query(true)
      .reply(200, [pullRequestFile('environments/infradev/beta.json')])
    nock(API)
      .post(`${TENANTS}/git/refs`, {
        ref: `refs/heads/op/${OPERATION}`,
        sha: SHA
      })
      .reply(201, {})
    const commit = nock(API)
      .post('/graphql', ({ variables }) => {
        const { input } = variables
        return (
          input.expectedHeadOid === SHA &&
          input.branch.branchName === `op/${OPERATION}` &&
          input.branch.repositoryNameWithOwner ===
            `${OWNER}/ai-platform-tenants` &&
          input.fileChanges.additions[0].path === PATH &&
          input.fileChanges.additions[0].contents ===
            Buffer.from(DOCUMENT).toString('base64')
        )
      })
      .reply(200, { data: { createCommitOnBranch: { commit: { oid: 'b' } } } })
    pullRequestCreated(
      11,
      (body) =>
        body.head === `op/${OPERATION}` &&
        body.title === 'chore(infradev): write alpha'
    )
    const labels = nock(API)
      .post(`${TENANTS}/issues/11/labels`, {
        labels: ['gitops', 'env:infradev']
      })
      .reply(200, [])
    const autoMerge = nock(API)
      .post(
        '/graphql',
        ({ query, variables }) =>
          query.includes('enablePullRequestAutoMerge') &&
          variables.headline === 'chore(infradev): write alpha (#11)' &&
          variables.body.startsWith(`Operation-Id: ${OPERATION}`)
      )
      .reply(200, { data: { enablePullRequestAutoMerge: {} } })

    await expect(
      submit(commandInput({ env: submission() }))
    ).resolves.toMatchObject({ outcome: 'pr-raised', number: 11 })
    expect(commit.isDone()).toBe(true)
    expect(labels.isDone()).toBe(true)
    expect(autoMerge.isDone()).toBe(true)
    expect(jobSummary()).toContain('### pr-raised')
  })

  test('starts a branch left by an earlier attempt again from the validated main', async () => {
    noOperationPullRequest()
    openPullRequests([])
    nock(API).post(`${TENANTS}/git/refs`).reply(422, {})
    const reset = nock(API)
      .patch(`${TENANTS}/git/refs/heads%2Fop%2F${OPERATION}`, {
        sha: SHA,
        force: true
      })
      .reply(200, {})
    nock(API).post('/graphql').times(2).reply(200, { data: {} })
    pullRequestCreated(12)
    nock(API).post(`${TENANTS}/issues/12/labels`).reply(200, [])

    await expect(
      submit(commandInput({ env: submission() }))
    ).resolves.toMatchObject({ outcome: 'pr-raised', number: 12 })
    expect(reset.isDone()).toBe(true)
  })

  test('deletes the file for a remove submission', async () => {
    noOperationPullRequest()
    openPullRequests([])
    nock(API).post(`${TENANTS}/git/refs`).reply(201, {})
    const commit = nock(API)
      .post(
        '/graphql',
        ({ variables }) =>
          variables.input?.fileChanges?.deletions?.[0]?.path === PATH
      )
      .reply(200, { data: {} })
    pullRequestCreated(13)
    nock(API).post(`${TENANTS}/issues/13/labels`).reply(200, [])
    nock(API).post('/graphql').reply(200, { data: {} })

    await submit(
      commandInput({
        env: submission({ AIP_ACTION: 'remove', AIP_DOCUMENT: '' })
      })
    )

    expect(commit.isDone()).toBe(true)
  })

  test('surfaces a failure to create the branch', async () => {
    noOperationPullRequest()
    openPullRequests([])
    nock(API).post(`${TENANTS}/git/refs`).reply(403, {})

    await expect(
      submit(commandInput({ env: submission() }))
    ).rejects.toMatchObject({ status: 403 })
  })

  describe('when nothing on main blocks the pull request', () => {
    const HEAD = 'b'.repeat(40)

    function newPullRequest(number) {
      noOperationPullRequest()
      openPullRequests([])
      nock(API).post(`${TENANTS}/git/refs`).reply(201, {})
      nock(API)
        .post('/graphql', ({ query }) => query.includes('createCommitOnBranch'))
        .reply(200, { data: {} })
      pullRequestCreated(number)
      nock(API).post(`${TENANTS}/issues/${number}/labels`).reply(200, [])
    }

    // GitHub refuses to arm auto-merge when no required check or review
    // blocks the pull request.
    function autoMergeRefused(status = 'clean') {
      return nock(API)
        .post('/graphql', ({ query }) =>
          query.includes('enablePullRequestAutoMerge')
        )
        .reply(200, {
          data: { enablePullRequestAutoMerge: null },
          errors: [
            {
              type: 'UNPROCESSABLE',
              path: ['enablePullRequestAutoMerge'],
              message: `Pull request Pull request is in ${status} status`
            }
          ]
        })
    }

    function checkRuns(runs) {
      return nock(API)
        .get(`${TENANTS}/commits/${HEAD}/check-runs`)
        .query({ check_name: VALIDATE_CHECK, per_page: '10' })
        .reply(200, { total_count: runs.length, check_runs: runs })
    }

    function merged(number) {
      return nock(API)
        .put(
          `${TENANTS}/pulls/${number}/merge`,
          (body) =>
            body.merge_method === 'squash' &&
            body.sha === HEAD &&
            body.commit_title === `chore(infradev): write alpha (#${number})` &&
            body.commit_message.startsWith(`Operation-Id: ${OPERATION}`)
        )
        .reply(200, { merged: true })
    }

    // A clock that moves only when the step sleeps.
    function clock() {
      let now = 1_000_000
      return {
        now: () => now,
        sleep: vi.fn(async (ms) => {
          now += ms
        })
      }
    }

    test('merges itself once the validate check has passed on the head', async () => {
      newPullRequest(14)
      autoMergeRefused()
      checkRuns([{ id: 1, status: 'completed', conclusion: 'success' }])
      const merge = merged(14)

      await expect(
        submit(commandInput({ env: submission() }))
      ).resolves.toMatchObject({ outcome: 'merged', number: 14 })
      expect(merge.isDone()).toBe(true)
      expect(jobSummary()).toContain('### merged')
    })

    test('waits for the validate check and trusts its newest run', async () => {
      newPullRequest(15)
      autoMergeRefused('unstable')
      checkRuns([])
      checkRuns([{ id: 2, status: 'in_progress', conclusion: null }])
      checkRuns([
        { id: 2, status: 'completed', conclusion: 'failure' },
        { id: 3, status: 'completed', conclusion: 'success' }
      ])
      const merge = merged(15)
      const timers = clock()

      await expect(
        submit(commandInput({ env: submission(), timers }))
      ).resolves.toMatchObject({ outcome: 'merged' })
      expect(merge.isDone()).toBe(true)
      expect(timers.sleep).toHaveBeenCalledTimes(2)
      expect(timers.sleep).toHaveBeenCalledWith(15_000)
    })

    test('never merges a head whose validate check failed', async () => {
      newPullRequest(16)
      autoMergeRefused()
      checkRuns([{ id: 4, status: 'completed', conclusion: 'failure' }])

      await expect(
        submit(commandInput({ env: submission() }))
      ).rejects.toMatchObject({
        outcome: 'checks-failed',
        message: expect.stringMatching(
          /^validate-desired-state \/ validate concluded failure on https:\/\//
        )
      })
    })

    test('leaves the pull request open, reported, past the wait', async () => {
      newPullRequest(17)
      autoMergeRefused()
      checkRuns([]).persist()
      const warning = vi.fn()
      const timers = clock()
      const input = commandInput({
        env: submission({ AIP_MERGE_WAIT_SECONDS: '20' }),
        timers
      })
      input.core = { ...input.core, warning }

      await expect(submit(input)).resolves.toMatchObject({
        outcome: 'pr-raised',
        number: 17
      })
      expect(timers.sleep).toHaveBeenCalledTimes(2)
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('had not completed')
      )
    })

    test('surfaces any other auto-merge error', async () => {
      newPullRequest(18)
      nock(API)
        .post('/graphql', ({ query }) =>
          query.includes('enablePullRequestAutoMerge')
        )
        .reply(200, {
          data: null,
          errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }]
        })

      await expect(
        submit(commandInput({ env: submission() }))
      ).rejects.toMatchObject({ name: 'GraphqlResponseError' })
    })

    test('completes a retried operation by merging its validated pull request', async () => {
      nock(API)
        .get(`${TENANTS}/pulls`)
        .query(true)
        .reply(200, [
          pullRequest({
            number: 19,
            title: 'chore(infradev): write alpha',
            body: `Submitted.\n\nOperation-Id: ${OPERATION}\n`,
            html_url: 'https://github.com/DEFRA/ai-platform-tenants/pull/19'
          })
        ])
      autoMergeRefused()
      checkRuns([{ id: 5, status: 'completed', conclusion: 'success' }])
      const merge = merged(19)

      await expect(
        submit(commandInput({ env: submission() }))
      ).resolves.toMatchObject({ outcome: 'merged', number: 19 })
      expect(merge.isDone()).toBe(true)
    })
  })
})

describe('abandon', () => {
  function input() {
    return commandInput({ env: { AIP_OPERATION_ID: OPERATION } })
  }

  test('closes the pull request and deletes its branch', async () => {
    nock(API).get(`${TENANTS}/pulls`).query(true).reply(200, [pullRequest()])
    const close = nock(API)
      .patch(`${TENANTS}/pulls/7`, { state: 'closed' })
      .reply(200, {})
    const remove = nock(API)
      .delete(`${TENANTS}/git/refs/heads%2Fop%2F${OPERATION}`)
      .reply(204)

    await expect(abandon(input())).resolves.toEqual({
      outcome: 'abandoned',
      number: 7,
      url: 'https://github.com/DEFRA/ai-platform-tenants/pull/7'
    })
    expect(close.isDone()).toBe(true)
    expect(remove.isDone()).toBe(true)
  })

  test('leaves a merged pull request alone', async () => {
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query(true)
      .reply(200, [pullRequest({ merged_at: '2026-10-13T00:00:00Z' })])

    await expect(abandon(input())).resolves.toMatchObject({
      outcome: 'already-merged'
    })
  })

  test('reports nothing to abandon without a pull request', async () => {
    nock(API).get(`${TENANTS}/pulls`).query(true).reply(200, [])

    await expect(abandon(input())).resolves.toEqual({
      outcome: 'nothing-to-abandon'
    })
  })

  test('tolerates a branch that is already gone', async () => {
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query(true)
      .reply(200, [pullRequest({ state: 'closed' })])
    nock(API)
      .delete(`${TENANTS}/git/refs/heads%2Fop%2F${OPERATION}`)
      .reply(422, {})

    await expect(abandon(input())).resolves.toMatchObject({
      outcome: 'abandoned'
    })
  })
})

describe('prune', () => {
  const OLD = '2026-01-01T00:00:00Z'

  function branches(...refs) {
    nock(API).get(`${TENANTS}/git/matching-refs/heads%2Fop%2F`).reply(200, refs)
  }

  test('deletes an old operation branch with no open pull request (R7)', async () => {
    branches(matchingRef('op/old-operation-1', 'o1'))
    nock(API).get(`${TENANTS}/git/commits/o1`).reply(200, gitCommit(OLD))
    nock(API)
      .get(`${TENANTS}/pulls`)
      .query({
        head: `${OWNER}:op/old-operation-1`,
        state: 'open',
        per_page: '1'
      })
      .reply(200, [])
    const removed = nock(API)
      .delete(`${TENANTS}/git/refs/heads%2Fop%2Fold-operation-1`)
      .reply(204)

    await expect(prune(commandInput({ env: {} }))).resolves.toEqual({
      deleted: ['op/old-operation-1']
    })
    expect(removed.isDone()).toBe(true)
  })

  test('keeps a recent branch and one with an open pull request', async () => {
    branches(
      matchingRef('op/new-operation-1', 'n1'),
      matchingRef('op/open-operation-1', 'p1')
    )
    nock(API)
      .get(`${TENANTS}/git/commits/n1`)
      .reply(200, gitCommit(new Date().toISOString()))
    nock(API).get(`${TENANTS}/git/commits/p1`).reply(200, gitCommit(OLD))
    nock(API).get(`${TENANTS}/pulls`).query(true).reply(200, [pullRequest()])

    await expect(
      prune(commandInput({ env: { AIP_DAYS: '7' } }))
    ).resolves.toEqual({
      deleted: []
    })
  })

  test('refuses a number of days that is not a whole number', async () => {
    await expect(
      prune(commandInput({ env: { AIP_DAYS: '1.5' } }))
    ).rejects.toMatchObject({ outcome: 'failed' })
  })
})
