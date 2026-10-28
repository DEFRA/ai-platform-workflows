import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import { buildEvent } from '../../src/events.js'
import {
  API,
  commandInput,
  exportedVariables,
  OWNER
} from '../helpers/github.js'
import { eventProblems, SCHEMA, SCHEMA_FILE } from '../helpers/event-schema.js'

// Every event the workflows can build, from the real build-event command and
// a run report shaped as infra `checks run-report` writes it, is checked
// against the schema the Portal API and the worker validate with. A drift
// between the two (an apply event with no team, no commit time or an empty
// resources[]) is dropped by the backend, so no apply would move an operation.

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const FIRST = '1'.repeat(40)
const SECOND = '2'.repeat(40)
const MANUAL = '3'.repeat(40)
const HEAD = '4'.repeat(40)
const PERSON = 'entra:0f8fad5b-d9cb-469f-a165-70867728950e'
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const ARM =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers'
const PULL = 'https://github.com/DEFRA/ai-platform-tenants/pull/9'

const ALPHA = {
  tags: { 'aip-operation-id': 'op-00000001' },
  project: {
    id: `${ARM}/Microsoft.CognitiveServices/accounts/a/projects/aip-alpha`,
    name: 'aip-alpha'
  },
  deployments: {
    'gpt-5-nano': {
      id: `${ARM}/Microsoft.CognitiveServices/accounts/a/deployments/alpha-gpt-5-nano`,
      name: 'alpha-gpt-5-nano',
      region: 'uksouth'
    }
  },
  api: {
    id: `${ARM}/Microsoft.ApiManagement/service/s/apis/alpha`,
    name: 'alpha',
    path: 'alpha'
  },
  registration: {
    client_id: '00000000-0000-0000-0000-0000000000c1',
    object_id: '00000000-0000-0000-0000-0000000000a1',
    service_principal_object_id: '00000000-0000-0000-0000-0000000000b1'
  }
}

function commit(sha, files, date = '2026-10-26T12:00:24Z') {
  return {
    sha,
    commit: { committer: { date } },
    files: files.map((filename) => ({ filename }))
  }
}

function applyReport(overrides = {}) {
  return {
    schemaVersion: 1,
    outcome: 'success',
    appliedSha: HEAD,
    operations: [
      { sha: FIRST, operationIds: ['op-00000001'], traceparent: TRACE }
    ],
    failingTeams: [],
    unattributedFailure: false,
    outputs: { teams: { value: { alpha: ALPHA } } },
    ...overrides
  }
}

const APPLY = ['deploying', 'deployed', 'deploy-failed']
const ALPHA_COMMITS = [commit(FIRST, ['environments/infradev/alpha.json'])]

// What each scenario runs: the environment of the job, the run report it
// leaves, the commits GitHub knows, and the statuses it sends.
const SCENARIOS = [
  {
    name: 'a portal write: requested, committed and a failed check',
    env: {
      AIP_EVENT_SOURCE: 'submit',
      AIP_ACTION: 'write',
      AIP_PATH: 'environments/infradev/alpha.json',
      AIP_REQUESTER: PERSON,
      AIP_TRACE_PARENT: TRACE,
      AIP_CDP_REQUEST_ID: 'req-1',
      AIP_EVENT_OPERATION_IDS: 'op-00000001',
      AIP_COMMIT_SHA: FIRST,
      AIP_COMMITTED_AT: '2026-10-26T12:00:24Z'
    },
    statuses: [
      ['requested'],
      ['committed'],
      ['checks-failed', { code: 'validation-failed', message: 'No.' }],
      ['checks-failed', { code: 'stale-revision', message: 'Moved on.' }],
      ['checks-failed', { code: 'paused', message: 'Paused.' }],
      ['checks-failed', { code: 'commit-conflict', message: 'Conflict.' }]
    ]
  },
  {
    name: 'a removal and a revert',
    env: {
      AIP_EVENT_SOURCE: 'submit',
      AIP_ACTION: 'remove',
      AIP_PATH: 'environments/infradev/alpha.json',
      AIP_REQUESTER: PERSON,
      AIP_EVENT_OPERATION_IDS: 'op-00000001,op-00000002',
      AIP_COMMIT_SHA: FIRST,
      AIP_COMMITTED_AT: '2026-10-26T12:00:24Z'
    },
    statuses: [['requested'], ['committed']]
  },
  {
    name: 'a revert on the platform pin file',
    env: {
      AIP_EVENT_SOURCE: 'submit',
      AIP_ACTION: 'revert',
      AIP_PATH: 'environments/infradev/platform.json',
      AIP_REQUESTER: 'app:ai-platform-orchestrator',
      AIP_EVENT_OPERATION_IDS: 'op-00000003',
      AIP_COMMIT_SHA: FIRST,
      AIP_COMMITTED_AT: '2026-10-26T12:00:24Z'
    },
    statuses: [['requested'], ['committed']]
  },
  {
    name: 'the apply of one operation, which succeeds',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport(),
    commits: ALPHA_COMMITS,
    statuses: [['deploying'], ['deployed']]
  },
  {
    name: 'the apply of one operation, which fails',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({
      outcome: 'failure',
      failingTeams: ['alpha'],
      unattributedFailure: false
    }),
    commits: ALPHA_COMMITS,
    statuses: [['deploy-failed']]
  },
  {
    name: 'the apply of one operation, held because the environment is paused',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({ outcome: 'pending' }),
    commits: ALPHA_COMMITS,
    statuses: [['deploy-failed', { code: 'paused', message: 'Paused.' }]]
  },
  {
    name: 'the apply of two operations of different teams',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({
      operations: [
        { sha: SECOND, operationIds: ['op-00000002'], traceparent: null },
        { sha: FIRST, operationIds: ['op-00000001'], traceparent: TRACE }
      ],
      outputs: {
        teams: { value: { alpha: ALPHA, bravo: { ...ALPHA, api: null } } }
      }
    }),
    commits: [
      ...ALPHA_COMMITS,
      commit(
        SECOND,
        ['environments/infradev/bravo.json'],
        '2026-10-26T12:05:00Z'
      )
    ],
    statuses: [...APPLY.map((status) => [status])]
  },
  {
    name: 'the apply of a removal: the team has no outputs',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({ outputs: { teams: { value: {} } } }),
    commits: ALPHA_COMMITS,
    statuses: [['deployed']]
  },
  {
    name: 'the apply of the platform state',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({ outputs: {}, state: 'platform' }),
    commits: [commit(FIRST, ['environments/infradev/platform.json'])],
    statuses: [['deploying'], ['deployed']]
  },
  {
    name: 'a break-glass commit that has a pull request',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({
      operations: [{ sha: MANUAL, operationIds: [], traceparent: null }]
    }),
    commits: [commit(MANUAL, ['environments/infradev/alpha.json'])],
    pulls: { [MANUAL]: [{ html_url: PULL }] },
    statuses: [...APPLY.map((status) => [status])]
  },
  {
    name: 'a manual commit with no pull request',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({
      operations: [{ sha: MANUAL, operationIds: [], traceparent: null }]
    }),
    commits: [commit(MANUAL, ['environments/infradev/alpha.json'])],
    pulls: { [MANUAL]: [] },
    statuses: [...APPLY.map((status) => [status])]
  },
  {
    name: 'an apply with no operation (a manual apply or reconcile-all)',
    env: { AIP_EVENT_SOURCE: 'apply' },
    report: applyReport({ operations: [] }),
    commits: [commit(HEAD, ['environments/infradev/alpha.json'])],
    statuses: [...APPLY.map((status) => [status])]
  },
  {
    name: 'pause.yml',
    env: { AIP_EVENT_SOURCE: 'pause' },
    statuses: [['paused'], ['resumed']]
  }
]

const CASES = SCENARIOS.flatMap((scenario) =>
  scenario.statuses.map(([status, failure]) => ({
    ...scenario,
    status,
    failure,
    title: `${status}${failure ? ` (${failure.code})` : ''}: ${scenario.name}`
  }))
)

let counter = 0

async function build({
  env,
  report,
  commits = [],
  pulls = {},
  status,
  failure
}) {
  counter += 1
  const file = join(process.env.RUNNER_TEMP, `conformance-${counter}.json`)
  const out = join(process.env.RUNNER_TEMP, `conformance-${counter}-out.json`)

  if (report) {
    writeFileSync(file, JSON.stringify(report))
  }

  for (const found of commits) {
    nock(API).persist().get(`${TENANTS}/commits/${found.sha}`).reply(200, found)
  }

  for (const [sha, found] of Object.entries(pulls)) {
    nock(API).persist().get(`${TENANTS}/commits/${sha}/pulls`).reply(200, found)
  }

  vi.stubEnv('GITHUB_ACTOR', 'ai-platform-orchestrator[bot]')

  const result = await buildEvent(
    commandInput({
      env: {
        AIP_ENVIRONMENT: 'infradev',
        AIP_EVENT_STATUS: status,
        AIP_EVENT_OPERATION_IDS: '',
        AIP_EVENT_REPORT: report ? file : '',
        AIP_EVENT_OUT: out,
        AIP_EVENT_FAILURE_CODE: failure?.code ?? '',
        AIP_EVENT_FAILURE_MESSAGE: failure?.message ?? '',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_ACTOR_ID: '9',
        ...env
      }
    })
  )

  return {
    result,
    sent: result.events > 0 ? JSON.parse(readFileSync(out, 'utf8')) : [],
    kept: report ? JSON.parse(readFileSync(file, 'utf8')).events : []
  }
}

describe('what the workflows send, against the schema the backend validates with', () => {
  test.each(CASES)('$title', async (scenario) => {
    const { result, sent, kept } = await build(scenario)

    // A build that gives up sends nothing and passes vacuously, so it counts.
    expect(exportedVariables().AIP_EVENT_FILE).not.toBe('')
    expect(result.events).toBeGreaterThan(0)

    for (const { body, groupId, deduplicationId } of sent) {
      expect(eventProblems(body)).toEqual([])
      expect(deduplicationId).toBe(body.eventId)
      expect(body.eventId.startsWith(`${groupId}:`)).toBe(true)
    }

    expect(kept.map((body) => eventProblems(body))).toEqual(kept.map(() => []))
  })

  test('the scenarios build every status and every action of the schema', async () => {
    const built = []

    for (const scenario of CASES) {
      built.push(...(await build(scenario)).sent.map(({ body }) => body))
      nock.cleanAll()
    }

    expect(new Set(built.map((body) => body.status))).toEqual(
      new Set(SCHEMA.properties.status.enum)
    )
    expect(new Set(built.map((body) => body.action))).toEqual(
      new Set(SCHEMA.properties.action.enum)
    )
  })

  test.runIf(process.env.AIP_INFRA_SCHEMAS)(
    'the schema copy is the one infra publishes',
    () => {
      expect(
        readFileSync(
          join(process.env.AIP_INFRA_SCHEMAS, 'event.schema.json'),
          'utf8'
        )
      ).toBe(readFileSync(SCHEMA_FILE, 'utf8'))
    }
  )

  test('the checker itself refuses what the backend dropped: no team, no commit time, empty resources', () => {
    const body = {
      schema: 'aip.gitops.event/1',
      eventId: 'op-00000001:deployed:4242:1',
      environment: 'infradev',
      team: null,
      path: null,
      action: 'apply',
      status: 'deployed',
      timestamp: '2026-10-26T13:00:00.000Z',
      source: 'apply',
      requestedBy: 'app:ai-platform-orchestrator',
      repository: 'DEFRA/ai-platform-tenants',
      traceparent: null,
      cdpRequestId: null,
      operationId: 'op-00000001',
      runId: 4242,
      runAttempt: 1,
      runUrl: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/4242',
      commitSha: FIRST,
      appliedSha: HEAD,
      resources: []
    }

    expect(eventProblems(body).join('\n')).toMatch(/team|path|committedAt/)
  })
})
