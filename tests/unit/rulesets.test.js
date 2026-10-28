import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import { verifyRulesets } from '../../src/rulesets.js'
import { commandInput, API, OWNER } from '../helpers/github.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const ORCHESTRATOR_ID = 111
const INFRADEV_ID = 222

function summary(name, id, source = 'Repository') {
  return { id, name, source_type: source, enforcement: 'active' }
}

const MAIN_ONLY = {
  ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }
}
const VALIDATE_CHECK = {
  context: 'validate-desired-state / validate',
  integration_id: 15368
}

function machineMain(overrides = {}) {
  return {
    id: 1,
    name: 'aip-machine-main',
    target: 'branch',
    conditions: MAIN_ONLY,
    source_type: 'Repository',
    enforcement: 'active',
    bypass_actors: [
      {
        actor_id: ORCHESTRATOR_ID,
        actor_type: 'Integration',
        bypass_mode: 'always'
      }
    ],
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: true
        }
      },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [VALIDATE_CHECK] }
      }
    ],
    ...overrides
  }
}

function machineProtect(overrides = {}) {
  return {
    id: 2,
    name: 'aip-machine-protect',
    target: 'branch',
    conditions: MAIN_ONLY,
    source_type: 'Repository',
    enforcement: 'active',
    bypass_actors: [],
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    ...overrides
  }
}

function given({
  list,
  main = machineMain(),
  protect = machineProtect(),
  defaultBranch = 'main'
} = {}) {
  if (defaultBranch) {
    nock(API).get(TENANTS).reply(200, { default_branch: defaultBranch })
  }

  nock(API)
    .get(`${TENANTS}/rulesets`)
    .query(true)
    .reply(
      200,
      list ?? [
        summary('aip-machine-main', 1),
        summary('aip-machine-protect', 2)
      ]
    )
  nock(API)
    .get('/apps/ai-platform-orchestrator')
    .reply(200, { id: ORCHESTRATOR_ID })
  nock(API)
    .get('/apps/ai-platform-orchestrator-infradev')
    .reply(200, { id: INFRADEV_ID })

  if (main) {
    nock(API).get(`${TENANTS}/rulesets/1`).query(true).reply(200, main)
  }

  if (protect) {
    nock(API).get(`${TENANTS}/rulesets/2`).query(true).reply(200, protect)
  }
}

function verify() {
  const { app, context } = commandInput({}, { repo: 'ai-platform-tenants' })

  return verifyRulesets(app, context.repo)
}

afterEach(() => nock.cleanAll())

describe('verifyRulesets', () => {
  test('passes when both machine rulesets are active and only the submit Apps bypass the first', async () => {
    given()

    await expect(verify()).resolves.toBeUndefined()
  })

  test('passes when both submit Apps bypass', async () => {
    given({
      main: machineMain({
        bypass_actors: [
          {
            actor_id: ORCHESTRATOR_ID,
            actor_type: 'Integration',
            bypass_mode: 'always'
          },
          {
            actor_id: INFRADEV_ID,
            actor_type: 'Integration',
            bypass_mode: 'always'
          }
        ]
      })
    })

    await expect(verify()).resolves.toBeUndefined()
  })

  test.each([
    ['aip-machine-main', [summary('aip-machine-protect', 2)]],
    ['aip-machine-protect', [summary('aip-machine-main', 1)]],
    [
      'aip-machine-main',
      [
        summary('aip-machine-main', 1, 'Organization'),
        summary('aip-machine-protect', 2)
      ]
    ]
  ])('refuses to run when %s is missing', async (name, list) => {
    given({ list, main: null, protect: null })

    await expect(verify()).rejects.toMatchObject({
      outcome: 'rulesets-changed',
      message: expect.stringContaining(`${name} is missing`)
    })
  })

  test.each([
    [
      'a person on the bypass list',
      {
        bypass_actors: [
          { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }
        ]
      }
    ],
    [
      'a team on the bypass list',
      {
        bypass_actors: [
          { actor_id: 9, actor_type: 'Team', bypass_mode: 'pull_request' }
        ]
      }
    ],
    [
      'an App that is not a submit App',
      {
        bypass_actors: [
          { actor_id: 999, actor_type: 'Integration', bypass_mode: 'always' }
        ]
      }
    ],
    [
      'a submit App that bypasses only through a pull request',
      {
        bypass_actors: [
          {
            actor_id: ORCHESTRATOR_ID,
            actor_type: 'Integration',
            bypass_mode: 'pull_request'
          }
        ]
      }
    ],
    ['no bypass at all, which stops the App committing', { bypass_actors: [] }],
    ['a bypass list it cannot read', { bypass_actors: undefined }]
  ])('refuses aip-machine-main with %s', async (_why, overrides) => {
    given({ main: machineMain(overrides) })

    await expect(verify()).rejects.toMatchObject({
      outcome: 'rulesets-changed',
      message: expect.stringContaining('aip-machine-main')
    })
  })

  test('refuses aip-machine-protect with any bypass actor', async () => {
    given({
      protect: machineProtect({
        bypass_actors: [
          {
            actor_id: ORCHESTRATOR_ID,
            actor_type: 'Integration',
            bypass_mode: 'always'
          }
        ]
      })
    })

    await expect(verify()).rejects.toMatchObject({
      outcome: 'rulesets-changed',
      message: expect.stringContaining('aip-machine-protect has a bypass list')
    })
  })

  test.each([
    [
      'aip-machine-main',
      'enforcement',
      { enforcement: 'evaluate' },
      'is not active'
    ],
    [
      'aip-machine-protect',
      'enforcement',
      { enforcement: 'disabled' },
      'is not active'
    ],
    [
      'aip-machine-main',
      'the pull request rule',
      { rules: [{ type: 'required_status_checks', parameters: {} }] },
      'no longer requires a pull request'
    ],
    [
      'aip-machine-main',
      'code-owner review',
      {
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              require_code_owner_review: false
            }
          },
          { type: 'required_status_checks', parameters: {} }
        ]
      },
      'no longer requires a pull request'
    ],
    [
      'aip-machine-main',
      'the required check',
      {
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              require_code_owner_review: true
            }
          }
        ]
      },
      'no longer requires a status check'
    ],
    ...[
      ['an empty check list', []],
      [
        'an unrelated check',
        [{ context: 'lint', integration_id: VALIDATE_CHECK.integration_id }]
      ],
      [
        'the check from another integration',
        [{ ...VALIDATE_CHECK, integration_id: 1 }]
      ],
      [
        'a check that only contains the name',
        [{ ...VALIDATE_CHECK, context: `${VALIDATE_CHECK.context}-other` }]
      ]
    ].map(([what, checks]) => [
      'aip-machine-main',
      what,
      {
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              require_code_owner_review: true
            }
          },
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: checks }
          }
        ]
      },
      'no longer requires a status check'
    ]),
    ...['aip-machine-main', 'aip-machine-protect'].flatMap((name) =>
      [
        ['a branch other than the default', { include: ['refs/heads/dev'] }],
        [
          'the default branch and another',
          { include: ['~DEFAULT_BRANCH', 'refs/heads/dev'] }
        ],
        ['an exclusion', { exclude: ['~DEFAULT_BRANCH'] }],
        ['no conditions', undefined]
      ].map(([what, change]) => [
        name,
        `its branch condition (${what})`,
        {
          conditions: change
            ? { ref_name: { ...MAIN_ONLY.ref_name, ...change } }
            : undefined
        },
        'no longer applies to the default branch alone'
      ])
    ),
    [
      'aip-machine-protect',
      'its target',
      { target: 'tag' },
      'no longer applies to the default branch alone'
    ],
    [
      'aip-machine-protect',
      'force-push protection',
      { rules: [{ type: 'deletion' }] },
      'no longer blocks force pushes and deletion'
    ],
    [
      'aip-machine-protect',
      'deletion protection',
      { rules: [{ type: 'non_fast_forward' }] },
      'no longer blocks force pushes and deletion'
    ]
  ])('refuses %s when %s changed', async (name, _what, overrides, reason) => {
    given(
      name === 'aip-machine-main'
        ? { main: machineMain(overrides) }
        : { protect: machineProtect(overrides) }
    )

    await expect(verify()).rejects.toMatchObject({
      outcome: 'rulesets-changed',
      message: expect.stringContaining(`${name} ${reason}`)
    })
  })

  test('accepts the rulesets exactly as scripts/setup/rulesets holds them', async () => {
    const template = (name) =>
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../scripts/setup/rulesets', name),
          'utf8'
        )
      )
    const live = (name, id, bypass) => ({
      ...template(name),
      id,
      source_type: 'Repository',
      bypass_actors: bypass
    })

    given({
      main: live('machine-main.json', 1, [
        {
          actor_id: ORCHESTRATOR_ID,
          actor_type: 'Integration',
          bypass_mode: 'always'
        }
      ]),
      protect: live('machine-protect.json', 2, [])
    })

    await expect(verify()).resolves.toBeUndefined()
  })

  test.each(['dev', 'master'])(
    'refuses to run when the default branch is %s: ~DEFAULT_BRANCH would no longer guard main',
    async (defaultBranch) => {
      given({ defaultBranch })

      await expect(verify()).rejects.toMatchObject({
        outcome: 'rulesets-changed',
        message: expect.stringContaining(`default branch is ${defaultBranch}`)
      })
    }
  )

  test('fails closed when GitHub cannot say which branch is the default', async () => {
    given({ defaultBranch: null })
    nock(API).get(TENANTS).reply(500)

    await expect(verify()).rejects.toMatchObject({ status: 500 })
  })

  test('works with an App that has not been installed under that slug', async () => {
    nock(API).get(TENANTS).reply(200, { default_branch: 'main' })
    nock(API)
      .get(`${TENANTS}/rulesets`)
      .query(true)
      .reply(200, [
        summary('aip-machine-main', 1),
        summary('aip-machine-protect', 2)
      ])
    nock(API)
      .get('/apps/ai-platform-orchestrator')
      .reply(200, { id: ORCHESTRATOR_ID })
    nock(API).get('/apps/ai-platform-orchestrator-infradev').reply(404)
    nock(API).get(`${TENANTS}/rulesets/1`).query(true).reply(200, machineMain())
    nock(API)
      .get(`${TENANTS}/rulesets/2`)
      .query(true)
      .reply(200, machineProtect())

    await expect(verify()).resolves.toBeUndefined()
  })

  test('fails closed when GitHub cannot say which Apps are installed', async () => {
    nock(API)
      .get(`${TENANTS}/rulesets`)
      .query(true)
      .reply(200, [
        summary('aip-machine-main', 1),
        summary('aip-machine-protect', 2)
      ])
    nock(API).get(`${TENANTS}/rulesets/1`).query(true).reply(200, machineMain())
    nock(API)
      .get(`${TENANTS}/rulesets/2`)
      .query(true)
      .reply(200, machineProtect())
    nock(API).get('/apps/ai-platform-orchestrator').reply(500)

    await expect(verify()).rejects.toMatchObject({ status: 500 })
  })

  test('fails closed when GitHub cannot say', async () => {
    nock(API).get(`${TENANTS}/rulesets`).query(true).reply(500)

    await expect(verify()).rejects.toMatchObject({ status: 500 })
  })

  test('needs an App token', async () => {
    const { context } = commandInput({}, { repo: 'ai-platform-tenants' })

    await expect(verifyRulesets(null, context.repo)).rejects.toMatchObject({
      outcome: 'failed',
      message: expect.stringContaining('App token')
    })
  })
})
