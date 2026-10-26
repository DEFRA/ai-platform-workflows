import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'
import { Octokit } from '@octokit/rest'

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
import { eventProblems } from '../helpers/event-schema.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const COMMIT = 'd'.repeat(40)
const OTHER_COMMIT = 'e'.repeat(40)
const PERSON = 'entra:0f8fad5b-d9cb-469f-a165-70867728950e'
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const NOW = new Date('2026-10-26T13:00:00.000Z')
const MADE = '2026-10-26T12:59:58Z'
// What GitHub says of the commits an apply names (commitsOf).
const COMMITS = {
  [COMMIT]: { committedAt: MADE, files: ['environments/infradev/alpha.json'] },
  [OTHER_COMMIT]: {
    committedAt: MADE,
    files: ['environments/infradev/bravo.json']
  }
}
const ARM = '/subscriptions/0/resourceGroups/rg/providers'
const ALPHA_OUTPUTS = {
  project: { id: `${ARM}/Microsoft.CognitiveServices/p`, name: 'aip-alpha' },
  deployments: {
    nano: { id: `${ARM}/Microsoft.CognitiveServices/d`, name: 'alpha-nano' }
  },
  api: { id: `${ARM}/Microsoft.ApiManagement/a`, name: 'alpha' },
  registration: { object_id: 'obj-1', service_principal_object_id: 'obj-2' }
}

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
    outputs: { teams: { value: { alpha: ALPHA_OUTPUTS } } },
    ...overrides
  }
}

function valid(events) {
  for (const event of events) {
    expect(eventProblems(event.body)).toEqual([])
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

  test('says the change failed its checks when nothing more is known', () => {
    const [event] = buildEvents({
      status: 'checks-failed',
      ids: ['op-00000001'],
      facts: submitFacts(),
      now: NOW
    })

    expect(event.body.failureReason).toEqual({
      code: 'checks-failed',
      message: 'The change failed its checks.',
      retryable: false
    })
  })

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
      commits: COMMITS,
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
      team: 'alpha',
      path: 'environments/infradev/alpha.json',
      commitSha: COMMIT,
      committedAt: MADE,
      appliedSha: COMMIT,
      requestedBy: 'app:ai-platform-orchestrator'
    })
    expect(events[1].body.eventId).toBe('op-00000002:deployed:4242:2')
    valid(events)
  })

  test('deployed: carries what the apply published for the team', () => {
    const [event] = buildEvents({
      status: 'deployed',
      report: report({
        operations: [{ sha: COMMIT, operationIds: ['op-00000001'] }]
      }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(event.body.resources).toEqual([
      {
        type: 'azapi_resource.foundry_project',
        name: 'aip-alpha',
        id: ALPHA_OUTPUTS.project.id
      },
      {
        type: 'azurerm_cognitive_deployment',
        name: 'alpha-nano',
        id: ALPHA_OUTPUTS.deployments.nano.id
      },
      {
        type: 'azurerm_api_management_api',
        name: 'alpha',
        id: ALPHA_OUTPUTS.api.id
      },
      { type: 'azuread_application', name: 'alpha', id: 'obj-1' },
      { type: 'azuread_service_principal', name: 'alpha', id: 'obj-2' }
    ])
    valid([event])
  })

  test('deployed: a removal, with no outputs for the team, has no resources', () => {
    const [event] = buildEvents({
      status: 'deployed',
      report: report({
        operations: [{ sha: COMMIT, operationIds: ['op-00000001'] }],
        outputs: { teams: { value: {} } }
      }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(event.body.resources).toEqual([])
    valid([event])
  })

  test.each([
    [
      'an operation whose commit changed no team file',
      { [COMMIT]: { committedAt: MADE, files: ['README.md'] } },
      'cannot name the team file of operation op-00000001'
    ],
    [
      'an operation whose commit changed two team files',
      {
        [COMMIT]: {
          committedAt: MADE,
          files: [
            'environments/infradev/alpha.json',
            'environments/infradev/bravo.json'
          ]
        }
      },
      'cannot name the team file of operation op-00000001'
    ],
    [
      'an operation whose commit has no known time',
      { [COMMIT]: { files: ['environments/infradev/alpha.json'] } },
      'cannot say when the commit of op-00000001 was made'
    ],
    [
      'an operation whose commit is unknown',
      {},
      'cannot name the team file of operation op-00000001'
    ]
  ])('refuses to build %s', (_why, commits, message) => {
    expect(() =>
      buildEvents({
        status: 'deploying',
        report: report({
          operations: [{ sha: COMMIT, operationIds: ['op-00000001'] }]
        }),
        facts: applyFacts(),
        commits,
        now: NOW
      })
    ).toThrow(message)
  })

  test('refuses a deployed event for a report with no applied commit', () => {
    expect(() =>
      buildEvents({
        status: 'deployed',
        report: report({ appliedSha: undefined }),
        facts: applyFacts(),
        commits: COMMITS,
        now: NOW
      })
    ).toThrow('the run report has no appliedSha for the deployed event')
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
      commits: COMMITS,
      now: NOW
    })

    expect(event.body.traceparent).toBe(TRACE)
    expect(event.body).not.toHaveProperty('appliedSha')
    expect(event.body).not.toHaveProperty('resources')
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
      commits: COMMITS,
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

  test('deploy-failed: only the operation of a failing team is attributable', () => {
    const events = buildEvents({
      status: 'deploy-failed',
      report: report({
        outcome: 'failure',
        operations: [
          { sha: COMMIT, operationIds: ['op-00000001'] },
          { sha: OTHER_COMMIT, operationIds: ['op-00000002'] }
        ],
        failingTeams: ['alpha'],
        unattributedFailure: false
      }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(
      events.map(({ body }) => [
        body.team,
        body.failingTeams,
        body.attributable
      ])
    ).toEqual([
      ['alpha', ['alpha'], true],
      ['bravo', ['alpha'], false]
    ])
    valid(events)
  })

  test('deploy-failed: no operation is attributable while a failure names no team, even if another does', () => {
    const events = buildEvents({
      status: 'deploy-failed',
      report: report({
        outcome: 'failure',
        operations: [
          { sha: COMMIT, operationIds: ['op-00000001'] },
          { sha: OTHER_COMMIT, operationIds: ['op-00000002'] }
        ],
        failingTeams: ['alpha'],
        unattributedFailure: true
      }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(events.map(({ body }) => body.attributable)).toEqual([false, false])
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
      commits: COMMITS,
      now: NOW
    })

    expect(event.body).toMatchObject({ failingTeams: [], attributable: false })
    valid([event])
  })

  test('deploy-failed for a paused environment is retryable', () => {
    const [event] = buildEvents({
      status: 'deploy-failed',
      report: report({ outcome: 'pending' }),
      ids: ['op-00000001'],
      failure: { code: 'paused', message: 'The environment is paused.' },
      facts: applyFacts(),
      commits: COMMITS,
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
      commits: COMMITS,
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
      team: null,
      path: null,
      commitSha: OTHER_COMMIT,
      committedAt: MADE,
      pullRequestUrl: 'https://github.com/DEFRA/x/pull/9'
    })
    expect(events[1].body.action).toBe('apply')
    valid(events)
  })

  test('a manual commit with no pull request is reported as the apply it is', () => {
    const [event] = buildEvents({
      status: 'deploying',
      report: report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(event.groupId).toBe(OTHER_COMMIT)
    expect(event.body).toMatchObject({
      action: 'apply',
      operationId: null,
      commitSha: OTHER_COMMIT
    })
    expect(event.body).not.toHaveProperty('pullRequestUrl')
    valid([event])
  })

  test('a run with nothing new to apply is one event with no operation, about the commit it applied', () => {
    const events = buildEvents({
      status: 'deployed',
      report: report({ operations: [] }),
      facts: applyFacts(),
      commits: COMMITS,
      now: NOW
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      groupId: COMMIT,
      deduplicationId: `${COMMIT}:deployed:4242:2`
    })
    expect(events[0].body).toMatchObject({
      operationId: null,
      team: null,
      path: null,
      commitSha: COMMIT,
      committedAt: MADE,
      resources: []
    })
    valid(events)
  })

  test('a failed apply with no report is about the environment alone', () => {
    const [event] = buildEvents({
      status: 'deploy-failed',
      failure: { code: 'paused', message: 'Paused.' },
      facts: applyFacts(),
      now: NOW
    })

    expect(event.groupId).toBe('infradev')
    expect(event.body).not.toHaveProperty('commitSha')
    expect(event.body).not.toHaveProperty('committedAt')
    valid([event])
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
      facts: submitFacts(),
      now: NOW
    })

    expect(events).toHaveLength(2)
    expect(events[0].body).toMatchObject({
      path: 'environments/infradev/alpha.json',
      team: 'alpha'
    })
    valid(events)
  })

  test('refuses a submit event that names no file', () => {
    expect(() =>
      buildEvents({
        status: 'requested',
        ids: ['op-00000001'],
        facts: submitFacts({ path: '' }),
        now: NOW
      })
    ).toThrow('cannot name the team file of operation op-00000001')
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

  test('refuses to overwrite a report it cannot read', () => {
    const file = join(process.env.RUNNER_TEMP, 'corrupt-report.json')
    writeFileSync(file, '{ not json')

    expect(() => recordEvents(file, [])).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  test('adds to the events a run report already holds, once per event ID', () => {
    const file = join(process.env.RUNNER_TEMP, 'old-report.json')
    const first = buildEvents({
      status: 'requested',
      ids: ['op-00000001'],
      facts: submitFacts(),
      now: NOW
    })
    const second = buildEvents({
      status: 'committed',
      ids: ['op-00000001'],
      facts: submitFacts({ commitSha: COMMIT, committedAt: MADE }),
      now: NOW
    })
    writeFileSync(file, JSON.stringify({ outcome: 'success' }))

    recordEvents(file, first)
    recordEvents(file, [...first, ...second])

    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.outcome).toBe('success')
    expect(kept.events.map((event) => event.status)).toEqual([
      'requested',
      'committed'
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

  // GitHub's answer for a commit of the state repository.
  function commitReply(sha, files = ['environments/infradev/alpha.json']) {
    return nock(API)
      .get(`${TENANTS}/commits/${sha}`)
      .reply(200, {
        sha,
        commit: { committer: { date: MADE } },
        files: files.map((filename) => ({ filename }))
      })
  }

  function applyEnv(file, overrides = {}) {
    return env({
      AIP_EVENT_STATUS: 'deployed',
      AIP_EVENT_SOURCE: 'apply',
      AIP_EVENT_OPERATION_IDS: '',
      AIP_EVENT_REPORT: file,
      ...overrides
    })
  }

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

  test('reads the operations of an apply from its run report, and the team and time from the commit', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'apply-report.json')
    writeFileSync(file, JSON.stringify(report()))
    commitReply(COMMIT)

    const result = await buildEvent(commandInput({ env: applyEnv(file) }))

    expect(result).toEqual({ events: 2 })
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.events.map((event) => event.operationId)).toEqual([
      'op-00000001',
      'op-00000002'
    ])
    expect(kept.events[0]).toMatchObject({
      team: 'alpha',
      path: 'environments/infradev/alpha.json',
      commitSha: COMMIT,
      committedAt: MADE
    })
    expect(kept.events[0].resources).toHaveLength(5)
    expect(kept.outcome).toBe('success')
    valid(kept.events.map((body) => ({ body })))
  })

  test('sends nothing, and never fails, when GitHub cannot say what a commit changed', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'apply-404-report.json')
    writeFileSync(file, JSON.stringify(report()))
    nock(API).get(`${TENANTS}/commits/${COMMIT}`).reply(404)

    await expect(
      buildEvent(commandInput({ env: applyEnv(file) }))
    ).resolves.toEqual({ events: 0 })
    expect(exportedVariables().AIP_EVENT_FILE).toBe('')
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('events')
  })

  test('takes a commit with no listed files as one that changed no team file', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'apply-nofiles-report.json')
    writeFileSync(file, JSON.stringify(report()))
    nock(API)
      .get(`${TENANTS}/commits/${COMMIT}`)
      .reply(200, { sha: COMMIT, commit: { committer: { date: MADE } } })

    await expect(
      buildEvent(commandInput({ env: applyEnv(file) }))
    ).resolves.toEqual({ events: 0 })
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
    commitReply(OTHER_COMMIT)
    nock(API)
      .get(`${TENANTS}/commits/${OTHER_COMMIT}/pulls`)
      .reply(200, [{ html_url: 'https://github.com/DEFRA/x/pull/9' }])

    await buildEvent(commandInput({ env: applyEnv(file) }))

    const [event] = JSON.parse(readFileSync(file, 'utf8')).events
    expect(event).toMatchObject({
      action: 'break-glass',
      pullRequestUrl: 'https://github.com/DEFRA/x/pull/9'
    })
    valid([{ body: event }])
  })

  test.each([
    ['the lookup fails', (scope) => scope.reply(500)],
    ['the commit has no pull request', (scope) => scope.reply(200, [])]
  ])(
    'sends a manual commit as an apply, with no link, when %s',
    async (_why, answer) => {
      vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
      const file = join(process.env.RUNNER_TEMP, 'bg2-report.json')
      writeFileSync(
        file,
        JSON.stringify(
          report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] })
        )
      )
      commitReply(OTHER_COMMIT)
      answer(nock(API).get(`${TENANTS}/commits/${OTHER_COMMIT}/pulls`))

      await buildEvent(commandInput({ env: applyEnv(file) }))

      const [event] = JSON.parse(readFileSync(file, 'utf8')).events
      expect(event).toMatchObject({ action: 'apply', operationId: null })
      expect(event).not.toHaveProperty('pullRequestUrl')
      valid([{ body: event }])
    }
  )

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

  test('works from the defaults: events written under RUNNER_TEMP, a first attempt, no report kept', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)

    await expect(
      buildEvent(
        commandInput({
          env: env({
            AIP_EVENT_OUT: '',
            AIP_EVENT_REPORT: '',
            RUNNER_TEMP: process.env.RUNNER_TEMP,
            GITHUB_RUN_ATTEMPT: undefined
          })
        })
      )
    ).resolves.toEqual({ events: 1 })

    const [event] = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, 'aip-events.json'), 'utf8')
    )
    expect(event.body.runAttempt).toBe(1)
    expect(event.body.eventId).toBe('op-00000001:requested:4242:1')
  })

  test('keeps a commit-conflict refusal in the run report as retryable, for the reconciler to read', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'conflict-report.json')

    await buildEvent(
      commandInput({
        env: env({
          AIP_EVENT_STATUS: 'checks-failed',
          AIP_EVENT_REPORT: file,
          AIP_EVENT_FAILURE_CODE: 'commit-conflict',
          AIP_EVENT_FAILURE_MESSAGE: 'main moved on 3 attempts'
        })
      })
    )

    const [kept] = JSON.parse(readFileSync(file, 'utf8')).events
    expect(kept).toMatchObject({
      operationId: 'op-00000001',
      status: 'checks-failed',
      failureReason: { code: 'commit-conflict', retryable: true }
    })
  })

  test('exports the time reporting has until, for the send to keep to', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const before = Math.floor(Date.now() / 1000)

    await buildEvent(commandInput({ env: env() }))

    const after = Math.ceil(Date.now() / 1000)
    const deadline = Number(exportedVariables().AIP_EVENT_DEADLINE)
    expect(deadline).toBeGreaterThanOrEqual(before + 10)
    expect(deadline).toBeLessThanOrEqual(after + 10)
  })

  test('honours AIP_PUBLISH_SECONDS for that time', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const before = Math.floor(Date.now() / 1000)

    await buildEvent(commandInput({ env: env({ AIP_PUBLISH_SECONDS: '4' }) }))

    expect(Number(exportedVariables().AIP_EVENT_DEADLINE)).toBeLessThanOrEqual(
      Math.ceil(Date.now() / 1000) + 4
    )
    expect(
      Number(exportedVariables().AIP_EVENT_DEADLINE)
    ).toBeGreaterThanOrEqual(before + 4)
  })

  // A GitHub that never answers `hangOn`, and rejects when the request's
  // signal aborts, as fetch does; everything else goes to nock.
  function hangingGitHub(hangOn) {
    return new Octokit({
      auth: 'github-token',
      request: {
        fetch: (url, options) =>
          String(url).includes(hangOn)
            ? new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () =>
                  reject(options.signal.reason)
                )
              })
            : fetch(url, options)
      }
    })
  }

  test('gives up, with a warning and no event, when GitHub is slower than the reporting budget', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'slow-report.json')
    writeFileSync(file, JSON.stringify(report()))
    const started = Date.now()

    await expect(
      buildEvent(
        commandInput({
          github: hangingGitHub(`/commits/${COMMIT}`),
          env: applyEnv(file, { AIP_PUBLISH_SECONDS: '1' })
        })
      )
    ).resolves.toEqual({ events: 0 })

    expect(Date.now() - started).toBeLessThan(5000)
    expect(exportedVariables().AIP_EVENT_FILE).toBe('')
    expect(jobSummary()).toContain('did not answer within the 1 seconds')
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('events')
  })

  test('does not pass a break-glass change off as an apply when the pull request lookup ran out of time', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)
    const file = join(process.env.RUNNER_TEMP, 'slow-bg-report.json')
    writeFileSync(
      file,
      JSON.stringify(
        report({ operations: [{ sha: OTHER_COMMIT, operationIds: [] }] })
      )
    )
    commitReply(OTHER_COMMIT)

    await expect(
      buildEvent(
        commandInput({
          github: hangingGitHub('/pulls'),
          env: applyEnv(file, { AIP_PUBLISH_SECONDS: '1' })
        })
      )
    ).resolves.toEqual({ events: 0 })
    expect(exportedVariables().AIP_EVENT_FILE).toBe('')
  })

  test('takes no operation IDs from a step that sets none', async () => {
    vi.stubEnv('GITHUB_ACTOR', BY_APP.actor)

    await expect(
      buildEvent(
        commandInput({
          env: env({
            AIP_EVENT_OPERATION_IDS: undefined,
            AIP_EVENT_STATUS: 'paused',
            AIP_EVENT_SOURCE: 'pause',
            AIP_EVENT_REPORT: ''
          })
        })
      )
    ).resolves.toEqual({ events: 1 })
  })

  test.each([
    ['an actor with no user ID', { GITHUB_ACTOR_ID: undefined }, 'someone'],
    [
      'a report that is not JSON',
      { AIP_EVENT_REPORT: 'corrupt.json' },
      'ai-platform-orchestrator[bot]'
    ]
  ])(
    'sends nothing, and never fails, for %s',
    async (_why, overrides, actor) => {
      vi.stubEnv('GITHUB_ACTOR', actor)
      writeFileSync(join(process.env.RUNNER_TEMP, 'corrupt.json'), '{ not json')
      const report = overrides.AIP_EVENT_REPORT
        ? join(process.env.RUNNER_TEMP, 'corrupt.json')
        : undefined

      await expect(
        buildEvent(
          commandInput({
            env: env({
              AIP_EVENT_SOURCE: 'apply',
              AIP_EVENT_OPERATION_IDS: 'op-00000001',
              ...overrides,
              ...(report && { AIP_EVENT_REPORT: report })
            })
          })
        )
      ).resolves.toEqual({ events: 0 })
      expect(exportedVariables().AIP_EVENT_FILE).toBe('')
    }
  )
})
