import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { held, heldBack, pauseGate } from '../../src/pause.js'
import {
  commandInput,
  exportedVariables,
  jobSummary
} from '../helpers/github.js'

const APP = 'ai-platform-orchestrator[bot]'

describe('heldBack', () => {
  test.each([
    [
      'an exempt App dispatching while paused',
      'true',
      'workflow_dispatch',
      APP,
      true
    ],
    [
      'the infradev App dispatching while paused',
      'true',
      'workflow_dispatch',
      'ai-platform-orchestrator-infradev[bot]',
      true
    ],
    [
      "an admin's hand run while paused",
      'true',
      'workflow_dispatch',
      'admin-a',
      false
    ],
    ['a push while paused', 'true', 'push', APP, false],
    ['a schedule while paused', 'true', 'schedule', 'someone', false],
    [
      'github-actions[bot] dispatching while paused',
      'true',
      'workflow_dispatch',
      'github-actions[bot]',
      false
    ],
    ['an exempt App when not paused', 'false', 'workflow_dispatch', APP, false],
    [
      'an exempt App when AIP_PAUSED is not set',
      '',
      'workflow_dispatch',
      APP,
      false
    ]
  ])('%s: %s', (_why, paused, eventName, actor, expected) => {
    expect(heldBack({ paused, eventName, actor })).toBe(expected)
  })
})

describe('pauseGate and held', () => {
  const file = () => join(process.env.RUNNER_TEMP, 'held.txt')
  const env = (overrides) => ({
    AIP_PAUSED: 'true',
    AIP_ACTOR: APP,
    AIP_ENVIRONMENT: 'infradev',
    AIP_HELD_FILE: file(),
    ...overrides
  })

  test('records a held run for the apply job and exports it there', async () => {
    await expect(pauseGate(commandInput({ env: env() }))).resolves.toEqual({
      held: true
    })
    expect(readFileSync(file(), 'utf8')).toBe('true\n')
    expect(jobSummary()).toContain('infradev is paused')

    await expect(held(commandInput({ env: env() }))).resolves.toEqual({
      held: true
    })
    expect(exportedVariables().AIP_HELD).toBe('true')
  })

  test('records a run that is not held, a push while paused included', async () => {
    await pauseGate(commandInput({ env: env() }, { eventName: 'push' }))

    expect(readFileSync(file(), 'utf8')).toBe('false\n')
    expect(jobSummary()).toContain('### not paused')
    await expect(held(commandInput({ env: env() }))).resolves.toEqual({
      held: false
    })
    expect(exportedVariables().AIP_HELD).toBe('false')
  })

  test('says so when the environment is not paused', async () => {
    await pauseGate(commandInput({ env: env({ AIP_PAUSED: 'false' }) }))

    expect(jobSummary()).toContain('infradev is not paused')
  })

  test('reads the actor from the run when none is given', async () => {
    vi.stubEnv('GITHUB_ACTOR', APP)

    await expect(
      pauseGate(commandInput({ env: env({ AIP_ACTOR: '' }) }))
    ).resolves.toEqual({ held: true })
  })

  test('fails closed when the pause check left no record', async () => {
    await expect(
      held(commandInput({ env: env({ AIP_HELD_FILE: `${file()}.missing` }) }))
    ).rejects.toMatchObject({
      outcome: 'failed',
      message: 'the pause check left no record'
    })
  })

  test('fails closed when the record says neither true nor false', async () => {
    writeFileSync(file(), 'maybe\n')

    await expect(held(commandInput({ env: env() }))).rejects.toMatchObject({
      outcome: 'failed',
      message: 'the pause check left no record'
    })
  })
})
