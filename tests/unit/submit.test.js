import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import {
  commitMessage,
  prepareSubmit,
  runScript,
  submit,
  TIMERS
} from '../../src/submit.js'
import { fileContent, gitRef } from '../fixtures/github-api.js'
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
const PIN_PATH = 'environments/infradev/platform.json'
const PERSON = 'entra:0f8fad5b-d9cb-469f-a165-70867728950e'
const DOCUMENT = `{\n  "revision": 2,\n  "updatedBy": "${PERSON}"\n}\n`
const BLOB = 'f'.repeat(40)
const NEW_HEAD = 'a1'.repeat(20)
const NEW_COMMIT = 'c0'.repeat(20)
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
    AIP_OPERATION_ID_INPUT: OPERATION,
    AIP_OPERATION_ID: OPERATION,
    AIP_EXPECTED_REVISION: '1',
    AIP_EXPECTED_BASE: '',
    AIP_CDP_REQUEST_ID: 'req-1',
    AIP_REQUESTED_BY: PERSON,
    AIP_REQUESTER: PERSON,
    AIP_APP_SLUG: 'ai-platform-orchestrator',
    AIP_TRACE_PARENT: '',
    AIP_PAUSED: 'false',
    AIP_MAIN_SHA: SHA,
    AIP_SCRIPTS: '/runner/scripts',
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

function pinOnMain() {
  nock(API)
    .get(`${DEPLOYMENTS}/contents/environments%2Finfradev%2Fplatform.json`)
    .query({ ref: 'main' })
    .reply(200, fileContent(pin()))
}

// The commits that touched the file on main, newest first.
function history(commits = [], repo = TENANTS, path = PATH) {
  return nock(API)
    .get(`${repo}/commits`)
    .query({ sha: 'main', path, per_page: '30' })
    .reply(200, commits)
}

function commitOn(operation, sha = NEW_COMMIT) {
  return {
    sha,
    commit: {
      message: `chore(infradev): write alpha\n\nOperation-Id: ${operation}\nRequested-By: ${PERSON}`,
      committer: { date: '2026-10-26T12:00:00Z' }
    }
  }
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

  test('names a revert as one', () => {
    expect(
      commitMessage({
        action: 'revert',
        environment: 'infradev',
        path: PATH,
        operationId: OPERATION,
        requestedBy: PERSON
      }).headline
    ).toBe('chore(infradev): revert alpha')
  })
})

describe('prepareSubmit', () => {
  test.each([
    [{ AIP_ACTION: 'merge' }, 'action must be write, remove or revert'],
    [{ AIP_ACTION: 'abandon' }, 'action must be write, remove or revert'],
    [{ AIP_ENVIRONMENT: 'Infradev' }, 'invalid environment'],
    [{ AIP_OPERATION_ID_INPUT: 'short' }, 'invalid operation_id'],
    [{ AIP_OPERATION_ID_INPUT: '' }, 'invalid operation_id'],
    [{ AIP_TRACE_PARENT: 'trace' }, 'invalid trace_parent'],
    [{ AIP_CDP_REQUEST_ID: 'not valid!' }, 'invalid cdp_request_id'],
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
    [
      { AIP_EXPECTED_BASE: BLOB },
      'expected_base is for the platform pin only; a team file names expected_revision'
    ],
    [{ AIP_DOCUMENT: '' }, 'document must be under 60 KB'],
    [{ AIP_DOCUMENT: 'x'.repeat(61440) }, 'document must be under 60 KB'],
    [
      { AIP_ACTION: 'revert', AIP_DOCUMENT: '' },
      'document must be under 60 KB'
    ],
    [{ AIP_ENVIRONMENT: undefined }, 'invalid environment'],
    [{ AIP_PATH: undefined }, 'path must be environments/infradev/{name}.json'],
    [
      { AIP_EXPECTED_REVISION: undefined },
      'expected_revision must be a whole number'
    ],
    [{ AIP_DOCUMENT: undefined }, 'document must be under 60 KB'],
    [{ AIP_OPERATION_ID_INPUT: undefined }, 'invalid operation_id']
  ])('refuses %o before writing anything', async (env, message) => {
    await expect(
      prepareSubmit(commandInput({ env: submission(env) }, BY_APP))
    ).rejects.toMatchObject({ outcome: 'checks-failed', message })
  })

  test('refuses to run outside a state repository', async () => {
    await expect(
      prepareSubmit(
        commandInput(
          { env: submission() },
          { repo: 'ai-platform-infra', ...BY_APP }
        )
      )
    ).rejects.toMatchObject({ outcome: 'checks-failed' })
  })

  test.each([
    [{ AIP_EXPECTED_BASE: '' }],
    [{ AIP_EXPECTED_BASE: 'main' }],
    [{ AIP_EXPECTED_BASE: undefined }],
    [{ AIP_EXPECTED_BASE: BLOB.toUpperCase() }]
  ])('refuses a pin that does not name its base (%o)', async (env) => {
    await expect(
      prepareSubmit(
        commandInput(
          {
            env: submission({
              AIP_PATH: PIN_PATH,
              AIP_REQUESTED_BY: 'app:ai-platform-orchestrator',
              ...env
            })
          },
          { repo: 'ai-platform-deployments', ...BY_APP }
        )
      )
    ).rejects.toMatchObject({
      outcome: 'checks-failed',
      message:
        "expected_base must be the pin file's blob SHA on main, or 0 for a new file"
    })
  })

  test('resolves a team file at the environment pin and stages its inputs', async () => {
    history()
    pinOnMain()
    tagResolves()
    environmentsRepo()

    await expect(
      prepareSubmit(commandInput({ env: submission() }, BY_APP))
    ).resolves.toEqual({
      kind: 'tenants',
      operationId: OPERATION,
      release: 'v0.4.0',
      sha: INFRA_SHA
    })

    const exported = exportedVariables()
    expect(exported).toMatchObject({
      AIP_KIND: 'tenants',
      AIP_OPERATION_ID: OPERATION,
      AIP_REQUESTER: PERSON,
      AIP_RELEASE: 'v0.4.0',
      AIP_SHA: INFRA_SHA
    })
    expect(exported).not.toHaveProperty('AIP_OUTCOME')
    expect(readFileSync(exported.AIP_DOCUMENT_FILE, 'utf8')).toBe(DOCUMENT)
  })

  test('stages a removal with no document and no file to write', async () => {
    history()
    pinOnMain()
    tagResolves()
    environmentsRepo()

    await expect(
      prepareSubmit(
        commandInput(
          { env: submission({ AIP_ACTION: 'remove', AIP_DOCUMENT: '' }) },
          BY_APP
        )
      )
    ).resolves.toMatchObject({ kind: 'tenants', release: 'v0.4.0' })
    expect(exportedVariables()).not.toHaveProperty('AIP_DOCUMENT_FILE')
  })

  test('stages a revert as a write of the document it is given', async () => {
    history()
    pinOnMain()
    tagResolves()
    environmentsRepo()

    await expect(
      prepareSubmit(
        commandInput({ env: submission({ AIP_ACTION: 'revert' }) }, BY_APP)
      )
    ).resolves.toMatchObject({ kind: 'tenants' })
    expect(readFileSync(exportedVariables().AIP_DOCUMENT_FILE, 'utf8')).toBe(
      DOCUMENT
    )
  })

  test("validates an environment's first pin at its own release, naming no base on a new file", async () => {
    history([], DEPLOYMENTS, PIN_PATH)
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
              AIP_PATH: PIN_PATH,
              AIP_DOCUMENT: JSON.stringify(pin()),
              AIP_REQUESTED_BY: 'app:ai-platform-orchestrator',
              AIP_EXPECTED_BASE: '0'
            })
          },
          { repo: 'ai-platform-deployments', ...BY_APP }
        )
      )
    ).resolves.toMatchObject({ kind: 'pins', release: 'v0.4.0' })
  })

  test('refuses a pin document that is not JSON', async () => {
    history([], DEPLOYMENTS, PIN_PATH)

    await expect(
      prepareSubmit(
        commandInput(
          {
            env: submission({
              AIP_PATH: PIN_PATH,
              AIP_DOCUMENT: '{ not json',
              AIP_EXPECTED_BASE: '0'
            })
          },
          { repo: 'ai-platform-deployments', ...BY_APP }
        )
      )
    ).rejects.toMatchObject({ message: 'document is not JSON' })
  })

  describe('an engineer who dispatches by hand', () => {
    const hand = (env = {}) =>
      submission({
        AIP_OPERATION_ID_INPUT: '',
        AIP_OPERATION_ID: '',
        AIP_DOCUMENT: DOCUMENT.replace(PERSON, 'github:583231'),
        ...env
      })

    function staged() {
      history([], TENANTS, PATH)
      pinOnMain()
      tagResolves()
      environmentsRepo()
    }

    test('is recorded by their GitHub user ID, whatever requested_by says, and gets an operation ID of their run', async () => {
      staged()

      await expect(
        prepareSubmit(commandInput({ env: hand() }, BY_ENGINEER))
      ).resolves.toMatchObject({ operationId: 'hand-4242' })

      expect(exportedVariables()).toMatchObject({
        AIP_REQUESTER: 'github:583231',
        AIP_OPERATION_ID: 'hand-4242'
      })
    })

    test('may not name the operation ID', async () => {
      await expect(
        prepareSubmit(
          commandInput(
            { env: hand({ AIP_OPERATION_ID_INPUT: OPERATION }) },
            BY_ENGINEER
          )
        )
      ).rejects.toMatchObject({
        outcome: 'checks-failed',
        message:
          'a hand run makes its own operation ID; leave operation_id empty'
      })
    })

    test('goes through while the environment is paused, as an admin may', async () => {
      staged()

      await expect(
        prepareSubmit(
          commandInput({ env: hand({ AIP_PAUSED: 'true' }) }, BY_ENGINEER)
        )
      ).resolves.toMatchObject({ operationId: 'hand-4242' })
    })

    test('is refused when the document does not name them as its author', async () => {
      history([], TENANTS, PATH)
      await expect(
        prepareSubmit(
          commandInput({ env: hand({ AIP_DOCUMENT: DOCUMENT }) }, BY_ENGINEER)
        )
      ).rejects.toMatchObject({
        message: 'updatedBy must be github:583231, who requested the change'
      })
    })
  })

  test.each([
    [
      'an App with no requested_by',
      { AIP_REQUESTED_BY: '' },
      BY_APP,
      'requested_by is required'
    ],
    ['a run with no sender', {}, {}, 'the run has no sender']
  ])(
    'refuses a change it cannot attribute: %s',
    async (_why, env, run, message) => {
      await expect(
        prepareSubmit(commandInput({ env: submission(env) }, run))
      ).rejects.toMatchObject({ outcome: 'checks-failed', message })
    }
  )

  describe('while the environment is paused', () => {
    test('holds a portal request: it commits nothing, and the operation is named so the refusal can be sent', async () => {
      await expect(
        prepareSubmit(
          commandInput({ env: submission({ AIP_PAUSED: 'true' }) }, BY_APP)
        )
      ).rejects.toMatchObject({
        outcome: 'paused',
        message: 'infradev is paused; an admin must resume it'
      })
      expect(exportedVariables()).toMatchObject({
        AIP_OPERATION_ID: OPERATION,
        AIP_REQUESTER: PERSON
      })
    })

    test('holds a write by the infradev App too', async () => {
      await expect(
        prepareSubmit(
          commandInput(
            {
              env: submission({
                AIP_PAUSED: 'true',
                AIP_APP_SLUG: 'ai-platform-orchestrator-infradev'
              })
            },
            {
              payload: {
                sender: {
                  type: 'Bot',
                  login: 'ai-platform-orchestrator-infradev[bot]',
                  id: 10
                }
              }
            }
          )
        )
      ).rejects.toMatchObject({ outcome: 'paused' })
    })
  })

  describe('an operation that already committed', () => {
    test('reports its commit and asks the next steps to do nothing, so a repeat dispatch is harmless', async () => {
      history([
        commitOn('some-other-operation-1', 'e'.repeat(40)),
        commitOn(OPERATION)
      ])

      await expect(
        prepareSubmit(commandInput({ env: submission() }, BY_APP))
      ).resolves.toEqual({
        kind: 'tenants',
        operationId: OPERATION,
        outcome: 'existing',
        commit: NEW_COMMIT
      })

      expect(exportedVariables()).toMatchObject({
        AIP_OUTCOME: 'existing',
        AIP_COMMIT_SHA: NEW_COMMIT,
        AIP_COMMITTED_AT: '2026-10-26T12:00:00Z'
      })
      expect(jobSummary()).toContain('### existing')
    })

    test('does not take a commit that only mentions the ID in its subject', async () => {
      history([
        {
          sha: NEW_COMMIT,
          commit: {
            message: `chore: revert ${OPERATION}`,
            committer: { date: '2026-10-26T12:00:00Z' }
          }
        }
      ])
      pinOnMain()
      tagResolves()
      environmentsRepo()

      await expect(
        prepareSubmit(commandInput({ env: submission() }, BY_APP))
      ).resolves.not.toHaveProperty('outcome')
    })
  })
})

describe('submit', () => {
  // The restage a moved head asks for: desired-state.sh restage.
  function restager(...results) {
    const run = vi.fn()

    for (const result of results) {
      run.mockReturnValueOnce(result)
    }

    return run
  }

  function clock() {
    return { sleep: vi.fn(async () => {}), jitter: vi.fn(() => 1500) }
  }

  function commitMutation(matches = () => true, reply) {
    return nock(API)
      .post('/graphql', ({ query, variables }) =>
        query.includes('createCommitOnBranch')
          ? matches(variables.input)
          : false
      )
      .reply(
        200,
        reply ?? {
          data: { createCommitOnBranch: { commit: { oid: NEW_COMMIT } } }
        }
      )
  }

  const MOVED = {
    data: { createCommitOnBranch: null },
    errors: [
      {
        type: 'STALE_DATA',
        message:
          'Expected branch to point to "aaa" but it did not. Pull and try again.'
      }
    ]
  }

  test('commits the file to main as the App, with the trailers, and opens no pull request', async () => {
    const commit = commitMutation((input) => {
      return (
        input.expectedHeadOid === SHA &&
        input.branch.branchName === 'main' &&
        input.branch.repositoryNameWithOwner ===
          `${OWNER}/ai-platform-tenants` &&
        input.message.headline === 'chore(infradev): write alpha' &&
        input.message.body ===
          `Operation-Id: ${OPERATION}\nRequested-By: ${PERSON}` &&
        input.fileChanges.additions[0].path === PATH &&
        input.fileChanges.additions[0].contents ===
          Buffer.from(DOCUMENT).toString('base64')
      )
    })

    await expect(submit(commandInput({ env: submission() }))).resolves.toEqual({
      outcome: 'committed',
      commit: NEW_COMMIT
    })

    expect(commit.isDone()).toBe(true)
    expect(exportedVariables().AIP_COMMIT_SHA).toBe(NEW_COMMIT)
    expect(exportedVariables().AIP_COMMITTED_AT).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    )
    expect(jobSummary()).toContain('### committed')
    expect(nock.pendingMocks()).toEqual([])
  })

  test('carries the trace of the request in the commit', async () => {
    const trace = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    const commit = commitMutation((input) =>
      input.message.body.endsWith(`Traceparent: ${trace}`)
    )

    await submit(commandInput({ env: submission({ AIP_TRACE_PARENT: trace }) }))

    expect(commit.isDone()).toBe(true)
  })

  test('deletes the file for a remove', async () => {
    const commit = commitMutation(
      (input) =>
        input.fileChanges.deletions[0].path === PATH &&
        input.message.headline === 'chore(infradev): remove alpha'
    )

    await submit(
      commandInput({
        env: submission({ AIP_ACTION: 'remove', AIP_DOCUMENT: '' })
      })
    )

    expect(commit.isDone()).toBe(true)
  })

  test('writes the document of a revert and says so', async () => {
    const commit = commitMutation(
      (input) =>
        input.fileChanges.additions[0].path === PATH &&
        input.message.headline === 'chore(infradev): revert alpha'
    )

    await submit(commandInput({ env: submission({ AIP_ACTION: 'revert' }) }))

    expect(commit.isDone()).toBe(true)
  })

  describe('when the head of main has moved', () => {
    test('stages and validates again on the new head, then commits on it', async () => {
      commitMutation(() => true, MOVED)
      const second = commitMutation(
        (input) => input.expectedHeadOid === NEW_HEAD
      )
      const restage = restager({
        status: 0,
        stdout: `staged\nmain-sha=${NEW_HEAD}\n`
      })
      const timers = clock()

      await expect(
        submit(commandInput({ env: submission(), timers, run: restage }))
      ).resolves.toMatchObject({ outcome: 'committed' })

      expect(second.isDone()).toBe(true)
      expect(restage).toHaveBeenCalledTimes(1)
      expect(timers.sleep).toHaveBeenCalledWith(1500)
      const [command, args, options] = restage.mock.calls[0]
      expect(command).toBe('bash')
      expect(args).toEqual(['/runner/scripts/desired-state.sh', 'restage'])
      expect(options.env.AIP_GIT_TOKEN).toBe('github-token')
    })

    test('gives up after the third attempt with commit-conflict, which sends no terminal event', async () => {
      commitMutation(() => true, MOVED)
      commitMutation(() => true, MOVED)
      commitMutation(() => true, MOVED)
      const restage = restager(
        { status: 0, stdout: `main-sha=${'b1'.repeat(20)}\n` },
        { status: 0, stdout: `main-sha=${'b2'.repeat(20)}\n` }
      )

      await expect(
        submit(
          commandInput({ env: submission(), timers: clock(), run: restage })
        )
      ).rejects.toMatchObject({ outcome: 'commit-conflict' })
      expect(restage).toHaveBeenCalledTimes(2)
    })

    test('succeeds on the third attempt', async () => {
      commitMutation(() => true, MOVED)
      commitMutation(() => true, MOVED)
      commitMutation((input) => input.expectedHeadOid === 'b2'.repeat(20))
      const restage = restager(
        { status: 0, stdout: `main-sha=${'b1'.repeat(20)}\n` },
        { status: 0, stdout: `main-sha=${'b2'.repeat(20)}\n` }
      )

      await expect(
        submit(
          commandInput({ env: submission(), timers: clock(), run: restage })
        )
      ).resolves.toMatchObject({ outcome: 'committed' })
    })

    test.each([
      [3, 'stale-revision'],
      [1, 'checks-failed']
    ])(
      'ends as the restage does when it exits %i: %s',
      async (status, outcome) => {
        commitMutation(() => true, MOVED)
        const restage = restager({ status, stdout: '' })

        await expect(
          submit(
            commandInput({ env: submission(), timers: clock(), run: restage })
          )
        ).rejects.toMatchObject({ outcome })
      }
    )

    test('stops when the restage prints no head', async () => {
      commitMutation(() => true, MOVED)

      await expect(
        submit(
          commandInput({
            env: submission(),
            timers: clock(),
            run: restager({ status: 0, stdout: 'nothing useful\n' })
          })
        )
      ).rejects.toMatchObject({ outcome: 'failed' })
    })

    test('waits one to three seconds between attempts', async () => {
      commitMutation(() => true, MOVED)
      commitMutation(() => true)
      const sleeps = []

      await submit(
        commandInput({
          env: submission(),
          timers: { sleep: async (ms) => sleeps.push(ms) },
          run: restager({ status: 0, stdout: `main-sha=${NEW_HEAD}\n` })
        })
      )

      expect(sleeps).toHaveLength(1)
      expect(sleeps[0]).toBeGreaterThanOrEqual(1000)
      expect(sleeps[0]).toBeLessThanOrEqual(3000)
    })
  })

  test('surfaces any other failure to commit', async () => {
    nock(API)
      .post('/graphql')
      .reply(200, {
        data: null,
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }]
      })

    await expect(
      submit(commandInput({ env: submission(), run: restager() }))
    ).rejects.toMatchObject({ name: 'GraphqlResponseError' })
  })

  test('surfaces a GraphQL error that names no message', async () => {
    nock(API)
      .post('/graphql')
      .reply(200, { data: null, errors: [{ type: 'FORBIDDEN' }] })

    await expect(
      submit(commandInput({ env: submission(), run: restager() }))
    ).rejects.toMatchObject({ name: 'GraphqlResponseError' })
  })

  test('surfaces an error that is not from GraphQL', async () => {
    nock(API).post('/graphql').reply(502, {})

    await expect(
      submit(commandInput({ env: submission(), run: restager() }))
    ).rejects.toMatchObject({ status: 502 })
  })
})

describe('the real timers and script runner', () => {
  test('wait, and wait one to three seconds between attempts', async () => {
    await TIMERS.sleep(1)

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const wait = TIMERS.jitter()

      expect(wait).toBeGreaterThanOrEqual(1000)
      expect(wait).toBeLessThanOrEqual(3000)
    }
  })

  test('run a program and report its exit code and output', () => {
    const result = runScript(
      process.execPath,
      ['-e', "console.log('main-sha=x'); process.exit(3)"],
      { encoding: 'utf8' }
    )

    expect(result.status).toBe(3)
    expect(result.stdout).toContain('main-sha=x')
  })
})
