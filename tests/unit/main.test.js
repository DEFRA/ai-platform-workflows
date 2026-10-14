import nock from 'nock'

import { COMMANDS, run } from '../../src/main.js'
import { OutcomeError } from '../../src/gitops.js'
import { gitRef } from '../fixtures/github-api.js'
import {
  API,
  commandInput,
  createOctokit,
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
      'abandon',
      'dispatch-apply',
      'dispatch-changed-environments',
      'latest-release',
      'merge-release',
      'move-major-tag',
      'preflight',
      'prepare-submit',
      'prepare-validation',
      'prune',
      'resolve-apply',
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
    vi.spyOn(COMMANDS, 'abandon').mockImplementation(command)

    await run(
      runInput({
        GITOPS_COMMAND: 'abandon',
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

  test('records an outcome a command returns', async () => {
    vi.spyOn(COMMANDS, 'abandon').mockResolvedValue({
      outcome: 'nothing-to-abandon'
    })

    await run(runInput({ GITOPS_COMMAND: 'abandon' }))

    expect(stepOutputs()).toEqual({ outcome: 'nothing-to-abandon' })
    expect(process.exitCode).toBeUndefined()
  })

  test('summarises then rethrows an unexpected failure', async () => {
    vi.spyOn(COMMANDS, 'abandon').mockRejectedValue(new Error('GitHub is down'))

    await expect(run(runInput({ GITOPS_COMMAND: 'abandon' }))).rejects.toThrow(
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
    expect(new OutcomeError('file-locked', 'held')).toMatchObject({
      name: 'OutcomeError',
      outcome: 'file-locked',
      message: 'held'
    })
  })
})
