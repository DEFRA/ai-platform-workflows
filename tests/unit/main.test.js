import nock from 'nock'

import { COMMANDS, run } from '../../src/main.js'
import { OutcomeError } from '../../src/gitops.js'
import { gitRef } from '../fixtures/github-api.js'
import {
  API,
  commandInput,
  createOctokit,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA,
  stepOutputs
} from '../helpers/github.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`

function runInput(env) {
  const { github, context, core } = commandInput()

  return { github, context, core, getOctokit: createOctokit, env }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  test('lists every command a workflow uses', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([
      'admin-check',
      'build-event',
      'dispatch-apply',
      'dispatch-changed-environments',
      'end-held',
      'held',
      'latest-release',
      'merge-release',
      'move-major-tag',
      'pause-gate',
      'preflight',
      'prepare-submit',
      'prepare-validation',
      'resolve-apply',
      'resolve-release',
      'submit',
      'submit-auto-pins'
    ])
  })

  test('runs the command with the contract API version', async () => {
    const pinned = nock(API, {
      reqheaders: { 'x-github-api-version': '2026-03-10' }
    })
      .get(`${TENANTS}/git/ref/heads%2Fmain`)
      .reply(200, gitRef('f'.repeat(40)))

    await run(
      runInput({ GITOPS_COMMAND: 'preflight', AIP_ENVIRONMENT: 'infradev' })
    )

    expect(pinned.isDone()).toBe(true)
  })

  test('gives the command an App client for the other repositories', async () => {
    const reader = nock(API, {
      reqheaders: { authorization: 'token app-installation-token' }
    })
      .get(`${TENANTS}/git/ref/heads%2Fmain`)
      .reply(200, gitRef(SHA))
    const command = vi.fn(({ app }) =>
      app.rest.git.getRef({
        owner: OWNER,
        repo: 'ai-platform-tenants',
        ref: 'heads/main'
      })
    )
    vi.spyOn(COMMANDS, 'held').mockImplementation(command)

    await run(
      runInput({
        GITOPS_COMMAND: 'held',
        GITOPS_APP_TOKEN: 'app-installation-token'
      })
    )

    expect(reader.isDone()).toBe(true)
  })

  test('records a named failure as the outcome and fails the step', async () => {
    nock(API)
      .get(`${TENANTS}/git/ref/heads%2Fmain`)
      .reply(200, gitRef('f'.repeat(40)))

    await expect(
      run(
        runInput({ GITOPS_COMMAND: 'preflight', AIP_ENVIRONMENT: 'infradev' })
      )
    ).resolves.toEqual({ outcome: 'superseded' })
    expect(stepOutputs()).toEqual({ outcome: 'superseded' })
    expect(jobSummary()).toContain('### superseded')
    expect(process.exitCode).toBe(1)
  })

  test('exports a named failure for the step that reports it as an event', async () => {
    nock(API)
      .get(`${TENANTS}/git/ref/heads%2Fmain`)
      .reply(200, gitRef('f'.repeat(40)))

    await run(
      runInput({ GITOPS_COMMAND: 'preflight', AIP_ENVIRONMENT: 'infradev' })
    )

    expect(exportedVariables()).toMatchObject({
      AIP_FAILURE_CODE: 'superseded',
      AIP_FAILURE_MESSAGE: expect.stringContaining('no longer the head of main')
    })
  })

  test('exports nothing for a failure the contract does not name', async () => {
    vi.spyOn(COMMANDS, 'held').mockRejectedValue(new Error('GitHub is down'))

    await expect(run(runInput({ GITOPS_COMMAND: 'held' }))).rejects.toThrow()

    expect(exportedVariables()).not.toHaveProperty('AIP_FAILURE_CODE')
  })

  test('records an outcome a command returns', async () => {
    vi.spyOn(COMMANDS, 'held').mockResolvedValue({
      outcome: 'nothing-to-hold'
    })

    await run(runInput({ GITOPS_COMMAND: 'held' }))

    expect(stepOutputs()).toEqual({ outcome: 'nothing-to-hold' })
    expect(process.exitCode).toBeUndefined()
  })

  test('summarises then rethrows an unexpected failure', async () => {
    vi.spyOn(COMMANDS, 'held').mockRejectedValue(new Error('GitHub is down'))

    await expect(run(runInput({ GITOPS_COMMAND: 'held' }))).rejects.toThrow(
      'GitHub is down'
    )
    expect(jobSummary()).toContain('### failed')
    expect(stepOutputs()).toEqual({ outcome: 'failed' })
  })

  test('refuses an unknown command', async () => {
    await expect(run(runInput({ GITOPS_COMMAND: 'deploy' }))).rejects.toThrow(
      'unknown GitOps command deploy'
    )
  })

  test('is what a named failure is made of', () => {
    expect(new OutcomeError('commit-conflict', 'held')).toMatchObject({
      name: 'OutcomeError',
      outcome: 'commit-conflict',
      message: 'held'
    })
  })
})
