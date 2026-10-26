import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import {
  buildEvent,
  buildEvents,
  principalOf,
  recordEvents
} from '../../src/events.js'
import {
  API,
  commandInput,
  exportedVariables,
  jobSummary,
  OWNER
} from '../helpers/github.js'
import { validate } from '../helpers/json-schema.js'

const SCHEMA = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../fixtures/aip-gitops/event.schema.json'),
    'utf8'
  )
)
const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const COMMIT = 'd'.repeat(40)
const OTHER_COMMIT = 'e'.repeat(40)
const PERSON = 'entra:0f8fad5b-d9cb-469f-a165-70867728950e'
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const NOW = new Date('2026-10-26T13:00:00.000Z')

const RUN = {
  repository: 'DEFRA/ai-platform-tenants',
  runId: 4242,
  runAttempt: 2,
  runUrl: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/4242'
}

function submitFacts(overrides = {}) {
  return {
    ...RUN,
    environment: 'infradev',
    source: 'submit',
    action: 'write',
    path: 'environments/infradev/alpha.json',
    requestedBy: PERSON,
    traceparent: TRACE,
    cdpRequestId: 'req-1',
    ...overrides
  }
}

function applyFacts(overrides = {}) {
  return {
    ...RUN,
    environment: 'infradev',
    source: 'apply',
    action: 'apply',
    requestedBy: 'app:ai-platform-orchestrator',
    ...overrides
  }
}

function report(overrides = {}) {
  return {
    outcome: 'success',
    appliedSha: COMMIT,
    operations: [{ sha: COMMIT, operationIds: ['op-00000001', 'op-00000002'] }],
    failingTeams: [],
    unattributedFailure: false,
    ...overrides
  }
}

function valid(events) {
  for (const event of events) {
    expect(validate(SCHEMA, event.body)).toEqual([])
  }
}

describe('buildEvents', () => {
  test('requested: names the operation, its run, the team and the requester', () => {
    const events = buildEvents({
      status: 'requested',
      ids: ['op-00000001'],
      facts: submitFacts(),
      now: NOW
    })

    expect(events).toEqual([
      {
        groupId: 'op-00000001',
        deduplicationId: 'op-00000001:requested:4242:2',
        body: {
          schema: 'aip.gitops.event/1',
          eventId: 'op-00000001:requested:4242:2',
          environment: 'infradev',
          team: 'alpha',
          path: 'environments/infradev/alpha.json',
          action: 'write',
          status: 'requested',
          timestamp: '2026-10-26T13:00:00.000Z',
          source: 'submit',
          requestedBy: PERSON,
          repository: 'DEFRA/ai-platform-tenants',
          traceparent: TRACE,
          cdpRequestId: 'req-1',
          operationId: 'op-00000001',
          runId: 4242,
          runAttempt: 2,
          runUrl: RUN.runUrl
        }
      }
    ])
    valid(events)
  })

  test('committed: carries the commit and when it was made', () => {
    const [event] = buildEvents({
      status: 'committed',
      ids: ['op-00000001'],
      facts: submitFacts({
        commitSha: COMMIT,
        committedAt: '2026-10-26T12:59:58.000Z',
        traceparent: '',
        cdpRequestId: ''
      }),
      now: NOW
    })

    expect(event.body).toMatchObject({
      status: 'committed',
      commitSha: COMMIT,
      committedAt: '2026-10-26T12:59:58.000Z',
      traceparent: null,
      cdpRequestId: null
    })
    valid([event])
  })

  test.each([
    ['checks-failed', true, false],
    ['stale-revision', true, true],
    ['paused', true, true],
    ['commit-conflict', true, true]
  ])(
    'checks-failed with the code %s is retryable: %s',
    (code, _listed, retryable) => {
      const [event] = buildEvents({
        status: 'checks-failed',
        ids: ['op-00000001'],
        failure: { code, message: 'the reason' },
        facts: submitFacts(),
        now: NOW
      })

      expect(event.body.failureReason).toEqual({
        code,
        message: 'the reason',
        retryable: code === 'checks-failed' ? false : retryable
      })
      valid([event])
    }
  )

  test('shortens a long failure message and defaults the code', () => {
    const [event] = buildEvents({
      status: 'checks-failed',
      ids: ['op-00000001'],
      failure: { message: 'x'.repeat(900) },
      facts: submitFacts(),
      now: NOW
    })

    expect(event.body.failureReason.code).toBe('checks-failed')
    expect(event.body.failureReason.message).toHaveLength(500)
    valid([event])
  })

  test('deployed: one event per operation in the report, each with the applied commit', () => {
    const events = buildEvents({
      status: 'deployed',
      report: report(),
      facts: applyFacts(),
      now: NOW
    })

    expect(events.map((event) => event.groupId)).toEqual([
      'op-00000001',
      'op-00000002'
    ])
    expect(events[0].body).toMatchObject({
      status: 'deployed',
      action: 'apply',
      source: 'apply',
      operationId: 'op-00000001',
      team: null,
      path: null,
      commitSha: COMMIT,
      appliedSha: COMMIT,
      resources: [],
      requestedBy: 'app:ai-platform-orchestrator'
    })
    expect(events[1].body.eventId).toBe('op-00000002:deployed:4242:2')
    valid(events)
  })

  test('deploying: sends the trace of the commit that carried it', () => {
    const [event] = buildEvents({
      status: 'deploying',
      report: report({
        operations: [
          { sha: COMMIT, operationIds: ['op-00000001'], traceparent: TRACE }
        ]
      }),
      facts: applyFacts(),
      now: NOW
    })

    expect(event.body.traceparent).toBe(TRACE)
    expect(event.body).not.toHaveProperty('appliedSha')
    valid([event])
  })

  test('deploy-failed: names the failing teams and whether a team is to blame', () => {
    const events = buildEvents({
      status: 'deploy-failed',
      report: report({
        outcome: 'failure',
        failingTeams: ['alpha'],
        unattributedFailure: false
      }),
      facts: applyFacts(),
      now: NOW
    })

    expect(events[0].body).toMatchObject({
      failingTeams: ['alpha'],
      attributable: true,
      failureReason: {
        code: 'deploy-failed',
        message: 'The apply failed; the run has the details.',
        retryable: false
      }
    })
    expect(events[0].body).not.toHaveProperty('resources')
    valid(events)
  })

  test('deploy-failed: a failure with no team is not attributable', () => {
    const [event] = buildEvents({
      status: 'deploy-failed',
      report: report({
        outcome: 'failure',
        failingTeams: [],
        unattributedFailure: true
      }),
      ids: ['op-00000001'],
      facts: applyFacts(),
      now: NOW
    })

    expect(event.body).toMatchObject({ failingTeams: [], attributable: false })
  })

  test('deploy-failed for a paused environment is retryable', () => {
    const [event] = buildEvents({
      status: 'deploy-failed',
      ids: ['op-00000001'],
      failure: { code: 'paused', message: 'The environment is paused.' },
      facts: applyFacts(),
      now: NOW
    })

    expect(event.body.failureReason).toEqual({
      code: 'paused',
      message: 'The environment is paused.',
      retryable: true
    })
    expect(event.body.attributable).toBe(false)
    valid([event])
  })

  test('a commit with no operation ID is a break-glass change, grouped by its commit', () => {
    const events = buildEvents({
      status: 'deployed',
      report: report({
        operations: [
          { sha: OTHER_COMMIT, operationIds: [] },
          { sha: COMMIT, operationIds: ['op-00000001'] }
        ]
      }),
      facts: applyFacts(),
      pullRequests: { [OTHER_COMMIT]: 'https://github.com/DEFRA/x/pull/9' },
      now: NOW
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      groupId: OTHER_COMMIT,
      deduplicationId: `${OTHER_COMMIT}:deployed:4242:2`
    })
    expect(events[0].body).toMatchObject({
      action: 'break-glass',
      operationId: null,
      commitSha: OTHER_COMMIT,
      pullRequestUrl: 'https://github.com/DEFRA/x/pull/9'
    })
    expect(events[1].body.action).toBe('apply')
    valid(events)
  })

  test('a break-glass change with no pull request has a null link', () => {
    const [event] = buildEvents({
      status: 'deploying',
      report: report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] }),
      facts: applyFacts(),
      now: NOW
    })

    expect(event.body.pullRequestUrl).toBeNull()
    valid([event])
  })

  test('a run with nothing new to apply is one event with no operation, grouped by environment', () => {
    const events = buildEvents({
      status: 'deployed',
      report: report({ operations: [] }),
      facts: applyFacts(),
      now: NOW
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      groupId: 'infradev',
      deduplicationId: 'infradev:deployed:4242:2'
    })
    expect(events[0].body.operationId).toBeNull()
    valid(events)
  })

  test('pause: paused and resumed are about the environment, not an operation', () => {
    const events = [
      ...buildEvents({
        status: 'paused',
        facts: applyFacts({
          source: 'pause',
          action: 'pause',
          requestedBy: 'github:583231'
        }),
        now: NOW
      }),
      ...buildEvents({
        status: 'resumed',
        facts: applyFacts({ source: 'pause', action: 'pause' }),
        now: NOW
      })
    ]

    expect(events.map((event) => event.groupId)).toEqual([
      'infradev',
      'infradev'
    ])
    expect(events[0].body).toMatchObject({
      action: 'pause',
      status: 'paused',
      operationId: null,
      team: null,
      path: null
    })
    valid(events)
  })

  test('refuses a status the contract does not have', () => {
    expect(() =>
      buildEvents({ status: 'merged', facts: submitFacts(), now: NOW })
    ).toThrow('unknown event status merged')
  })

  test('accepts the explicit IDs as the list a workflow passes', () => {
    const events = buildEvents({
      status: 'requested',
      ids: ['op-00000001', 'op-00000002'],
      facts: submitFacts({ path: '', team: 'alpha' }),
      now: NOW
    })

    expect(events).toHaveLength(2)
    expect(events[0].body).toMatchObject({ path: null, team: 'alpha' })
  })
})

describe('principalOf', () => {
  test.each([
    ['ai-platform-orchestrator[bot]', '9', 'app:ai-platform-orchestrator'],
    ['github-actions[bot]', '41898282', 'app:github-actions'],
    ['someone', '583231', 'github:583231']
  ])('names %s as one identity', (login, id, expected) => {
    expect(principalOf(login, id)).toBe(expected)
  })

  test.each([
    ['someone', ''],
    ['someone', 'not-a-number'],
    ['', '12'],
    ['Weird_Bot[bot]', '1']
  ])('refuses to guess for %s with the ID %s', (login, id) => {
    expect(() => principalOf(login, id)).toThrow(
      'cannot name the actor as one identity'
    )
  })
})

describe('recordEvents', () => {
  test('creates a report that holds only the events', () => {
    const file = join(process.env.RUNNER_TEMP, 'new-report.json')
    const events = buildEvents({
      status: 'requested',
      ids: ['op-00000001'],
      facts: submitFacts(),
      now: NOW
    })

    recordEvents(file, events)

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      events: [events[0].body]
    })
  })

  test('adds to the events a run report already holds, once per event ID', () => {
    const file = join(process.env.RUNNER_TEMP, 'old-report.json')
    const first = buildEvents({
      status: 'deploying',
      ids: ['op-00000001'],
      facts: applyFacts(),
      now: NOW
    })
    const second = buildEvents({
      status: 'deployed',
      ids: ['op-00000001'],
      facts: applyFacts(),
      now: NOW
    })
    writeFileSync(file, JSON.stringify({ outcome: 'success' }))

    recordEvents(file, first)
    recordEvents(file, [...first, ...second])

    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.outcome).toBe('success')
    expect(kept.events.map((event) => event.status)).toEqual([
      'deploying',
      'deployed'
    ])
  })
})

describe('buildEvent', () => {
  function env(overrides = {}) {
    return {
      AIP_EVENT_STATUS: 'requested',
      AIP_EVENT_SOURCE: 'submit',
      AIP_EVENT_OPERATION_IDS: 'op-00000001',
      AIP_EVENT_REPORT: join(process.env.RUNNER_TEMP, 'run-report.json'),
      AIP_EVENT_OUT: join(process.env.RUNNER_TEMP, 'events.json'),
      AIP_ENVIRONMENT: 'infradev',
      AIP_ACTION: 'write',
      AIP_PATH: 'environments/infradev/alpha.json',
      AIP_REQUESTER: PERSON,
      AIP_TRACE_PARENT: TRACE,
      AIP_CDP_REQUEST_ID: 'req-1',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_ACTOR_ID: '9',
      ...overrides
    }
  }

  const BY_APP = { actor: 'ai-platform-orchestrator[bot]' }

  test('keeps the event in the run report first, then writes what to send', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)

    const result = await buildEvent(commandInput({ env: env() }))

    expect(result).toEqual({ events: 1 })
    const report = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, 'run-report.json'), 'utf8')
    )
    const sent = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, 'events.json'), 'utf8')
    )
    expect(report.events).toEqual([sent[0].body])
    expect(sent[0]).toMatchObject({
      groupId: 'op-00000001',
      deduplicationId: 'op-00000001:requested:4242:1'
    })
    expect(exportedVariables().AIP_EVENT_FILE).toBe(
      join(process.env.RUNNER_TEMP, 'events.json')
    )
    valid(sent)
  })

  test('reads the operations of an apply from its run report', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'apply-report.json')
    writeFileSync(file, JSON.stringify(report()))

    const result = await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'deployed',
          AIP_EVENT_SOURCE: 'apply',
          AIP_EVENT_OPERATION_IDS: '',
          AIP_EVENT_REPORT: file
        })
      })
    )

    expect(result).toEqual({ events: 2 })
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.events.map((event) => event.operationId)).toEqual([
      'op-00000001',
      'op-00000002'
    ])
    expect(kept.outcome).toBe('success')
  })

  test('looks up the pull request of a break-glass commit', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'bg-report.json')
    writeFileSync(
      file,
      JSON.stringify(
        report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] })
      )
    )
    nock(API)
      .get(`${TENANTS}/commits/${OTHER_COMMIT}/pulls`)
      .reply(200, [{ html_url: 'https://github.com/DEFRA/x/pull/9' }])

    await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'deployed',
          AIP_EVENT_SOURCE: 'apply',
          AIP_EVENT_OPERATION_IDS: '',
          AIP_EVENT_REPORT: file
        })
      })
    )

    expect(
      JSON.parse(readFileSync(file, 'utf8')).events[0].pullRequestUrl
    ).toBe('https://github.com/DEFRA/x/pull/9')
  })

  test('sends a break-glass event with no link when the lookup fails', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'bg2-report.json')
    writeFileSync(
      file,
      JSON.stringify(
        report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] })
      )
    )
    nock(API).get(`${TENANTS}/commits/${OTHER_COMMIT}/pulls`).reply(500)

    await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'deployed',
          AIP_EVENT_SOURCE: 'apply',
          AIP_EVENT_OPERATION_IDS: '',
          AIP_EVENT_REPORT: file
        })
      })
    )

    expect(
      JSON.parse(readFileSync(file, 'utf8')).events[0].pullRequestUrl
    ).toBeNull()
  })

  test('names a person who ran pause.yml by their user ID', async () => {
    vi.stubEnv('GITHUB_ACTOR', 'someone')

    await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'paused',
          AIP_EVENT_SOURCE: 'pause',
          AIP_EVENT_OPERATION_IDS: '',
          GITHUB_ACTOR_ID: '583231'
        })
      })
    )

    const [event] = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, 'events.json'), 'utf8')
    )
    expect(event.body).toMatchObject({
      action: 'pause',
      requestedBy: 'github:583231',
      team: null
    })
  })

  test('accepts the operation IDs as a JSON list or separated by commas and spaces', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)

    expect(
      await buildEvent(
        commandInput({
          env: env({ AIP_EVENT_OPERATION_IDS: '["op-00000001","op-00000002"]' })
        })
      )
    ).toEqual({ events: 2 })
    expect(
      await buildEvent(
        commandInput({
          env: env({ AIP_EVENT_OPERATION_IDS: 'op-00000001, op-00000002' })
        })
      )
    ).toEqual({ events: 2 })
  })

  test('never fails the run: a problem is a warning and no event', async () => {
    const out = join(process.env.RUNNER_TEMP, 'none.json')

    await expect(
      buildEvent(
        commandInput({
          env: env({ AIP_EVENT_STATUS: 'merged', AIP_EVENT_OUT: out })
        })
      )
    ).resolves.toEqual({ events: 0 })

    expect(existsSync(out)).toBe(false)
    expect(exportedVariables().AIP_EVENT_FILE).toBe('')
    expect(jobSummary()).toContain('unknown event status merged')
  })

  test('names a failed pause check with the code and message it was given', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)

    await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'checks-failed',
          AIP_EVENT_FAILURE_CODE: 'paused',
          AIP_EVENT_FAILURE_MESSAGE: 'infradev is paused'
        })
      })
    )

    const [event] = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, 'events.json'), 'utf8')
    )
    expect(event.body.failureReason).toEqual({
      code: 'paused',
      message: 'infradev is paused',
      retryable: true
    })
  })
})
