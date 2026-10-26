import { existsSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import {
  dispatchApply,
  preflight,
  resolveApply,
  runnerFor
} from '../../src/apply.js'
import {
  comparison,
  deployment,
  deploymentStatuses,
  dispatchedRun,
  fileContent,
  folderContent,
  gitRef
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

const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const PIN = 'environments%2Finfradev%2Fplatform.json'

function headOfMain(repo, sha = SHA) {
  nock(API).get(`${repo}/git/ref/heads%2Fmain`).reply(200, gitRef(sha))
}

function environmentsRepo(entries = [registryEntry()]) {
  nock(API)
    .get(`${ENVIRONMENTS}/contents/registry.json`)
    .query({ ref: 'main' })
    .times(2)
    .reply(200, fileContent(registry(entries)))
  nock(API)
    .get(`${ENVIRONMENTS}/contents/global.tfvars.json`)
    .query(true)
    .reply(200, fileContent({ location: 'uksouth' }))
  nock(API)
    .get(
      `${ENVIRONMENTS}/contents/environments%2Finfradev%2Fplatform.tfvars.json`
    )
    .query(true)
    .reply(200, fileContent({ environment: 'infradev' }))
}

function pinOnMain(repo = DEPLOYMENTS, ref = 'main') {
  nock(API)
    .get(`${repo}/contents/${PIN}`)
    .query({ ref })
    .reply(200, fileContent(pin()))
  nock(API).get(`${INFRA}/git/ref/tags%2Fv0.4.0`).reply(200, gitRef(INFRA_SHA))
}

function lastDeployment(repo, sha, state = 'success') {
  nock(API)
    .get(`${repo}/deployments`)
    .query({ environment: 'infradev', per_page: '30' })
    .reply(200, sha ? [deployment(9, sha)] : [])

  if (sha) {
    nock(API)
      .get(`${repo}/deployments/9/statuses`)
      .query(true)
      .reply(200, deploymentStatuses(state))
  }
}

function latestPlatformDeployment(sha, state = 'success') {
  nock(API)
    .get(`${DEPLOYMENTS}/deployments`)
    .query({ environment: 'infradev', per_page: '1' })
    .reply(200, sha ? [deployment(9, sha)] : [])

  if (sha) {
    nock(API)
      .get(`${DEPLOYMENTS}/deployments/9/statuses`)
      .query(true)
      .reply(200, deploymentStatuses(state))
  }
}

const INFRADEV_LEG = {
  environment: 'infradev',
  runner: '["ubuntu-26.04"]',
  entra_enabled: true,
  team_registrations: true,
  release: 'v0.4.0',
  sha: INFRA_SHA
}

describe('runnerFor', () => {
  test('runs on the standard runner labels of the registry entry', () => {
    expect(runnerFor(registryEntry())).toBe('["ubuntu-26.04"]')
  })

  test('runs in the larger-runner group of the registry entry', () => {
    expect(runnerFor(registryEntry({ runner: { group: 'aip-dev' } }))).toBe(
      '{"group":"aip-dev"}'
    )
  })
})

describe('resolveApply', () => {
  function input(env, run = {}) {
    return commandInput(
      {
        env: {
          AIP_STATE: 'platform',
          AIP_CONFIG: join(process.env.RUNNER_TEMP, 'config'),
          ...env
        }
      },
      { repo: 'ai-platform-deployments', eventName: 'push', ...run }
    )
  }

  test('applies nothing from a commit that is no longer the head of main (R1)', async () => {
    headOfMain(DEPLOYMENTS, 'f'.repeat(40))

    await expect(resolveApply(input())).resolves.toEqual({ matrix: [] })
  })

  describe('after a push', () => {
    test('applies an environment whose pin changed since its last apply', async () => {
      headOfMain(DEPLOYMENTS)
      environmentsRepo()
      pinOnMain(DEPLOYMENTS, SHA)
      lastDeployment(DEPLOYMENTS, 'b1')
      nock(API)
        .get(`${DEPLOYMENTS}/compare/b1...${SHA}`)
        .query(true)
        .reply(
          200,
          comparison({ files: ['environments/infradev/platform.json'] })
        )

      await expect(resolveApply(input())).resolves.toEqual({
        matrix: [INFRADEV_LEG]
      })
      expect(
        existsSync(
          join(
            process.env.RUNNER_TEMP,
            'config',
            'environments',
            'infradev',
            'platform.tfvars.json'
          )
        )
      ).toBe(true)
      expect(jobSummary()).toContain('`infradev` at `v0.4.0`')
    })

    test('skips an environment unchanged since its last apply', async () => {
      headOfMain(DEPLOYMENTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))
      pinOnMain(DEPLOYMENTS, SHA)
      lastDeployment(DEPLOYMENTS, 'b1')
      nock(API)
        .get(`${DEPLOYMENTS}/compare/b1...${SHA}`)
        .query(true)
        .reply(
          200,
          comparison({ files: ['environments/sandbox/platform.json'] })
        )

      await expect(resolveApply(input())).resolves.toEqual({ matrix: [] })
      expect(jobSummary()).toContain('Nothing to apply.')
    })

    test('applies an environment for the first time when it has a folder', async () => {
      headOfMain(DEPLOYMENTS)
      environmentsRepo()
      pinOnMain(DEPLOYMENTS, SHA)
      lastDeployment(DEPLOYMENTS, null)
      nock(API)
        .get(`${DEPLOYMENTS}/contents/environments%2Finfradev`)
        .query({ ref: SHA })
        .reply(200, folderContent())

      await expect(resolveApply(input())).resolves.toEqual({
        matrix: [INFRADEV_LEG]
      })
    })

    test('skips an environment with no pin yet', async () => {
      headOfMain(DEPLOYMENTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))
      nock(API).get(`${DEPLOYMENTS}/contents/${PIN}`).query(true).reply(404)

      await expect(resolveApply(input())).resolves.toEqual({ matrix: [] })
    })
  })

  describe('after a dispatch', () => {
    test('skips team registrations when the entry turns them off', async () => {
      const { entra } = registryEntry()

      headOfMain(DEPLOYMENTS)
      environmentsRepo([
        registryEntry({ entra: { ...entra, teamRegistrations: false } })
      ])
      pinOnMain(DEPLOYMENTS, SHA)

      await expect(
        resolveApply(input({ AIP_ENVIRONMENT: 'infradev' }))
      ).resolves.toEqual({
        matrix: [{ ...INFRADEV_LEG, team_registrations: false }]
      })
    })

    test('creates no team registrations where Entra is off', async () => {
      const { entra } = registryEntry()

      headOfMain(DEPLOYMENTS)
      environmentsRepo([registryEntry({ entra: { ...entra, enabled: false } })])
      pinOnMain(DEPLOYMENTS, SHA)

      await expect(
        resolveApply(input({ AIP_ENVIRONMENT: 'infradev' }))
      ).resolves.toEqual({
        matrix: [
          { ...INFRADEV_LEG, entra_enabled: false, team_registrations: false }
        ]
      })
    })
    test('applies the environment it names whatever changed', async () => {
      headOfMain(DEPLOYMENTS)
      environmentsRepo()
      pinOnMain(DEPLOYMENTS, SHA)

      await expect(
        resolveApply(input({ AIP_ENVIRONMENT: 'infradev' }))
      ).resolves.toEqual({ matrix: [INFRADEV_LEG] })
    })

    test('applies every environment from main when asked for all, whatever changed (reconcile-all)', async () => {
      const sandbox = registryEntry({ name: 'sandbox' })
      headOfMain(DEPLOYMENTS)
      environmentsRepo([registryEntry(), sandbox])
      pinOnMain(DEPLOYMENTS, SHA)
      nock(API)
        .get(`${INFRA}/git/ref/tags%2Fv0.4.0`)
        .reply(200, gitRef(INFRA_SHA))
      nock(API)
        .get(`${DEPLOYMENTS}/contents/environments%2Fsandbox%2Fplatform.json`)
        .query({ ref: SHA })
        .reply(200, fileContent(pin({ environment: 'sandbox' })))
      nock(API)
        .get(
          `${ENVIRONMENTS}/contents/environments%2Fsandbox%2Fplatform.tfvars.json`
        )
        .query(true)
        .reply(200, fileContent({ environment: 'sandbox' }))

      const { matrix } = await resolveApply(
        input({ AIP_ALL: 'true' }, { eventName: 'workflow_dispatch' })
      )

      expect(matrix.map((leg) => leg.environment)).toEqual([
        'infradev',
        'sandbox'
      ])
    })

    test('refuses all with an environment, because they say different things', async () => {
      await expect(
        resolveApply(input({ AIP_ALL: 'true', AIP_ENVIRONMENT: 'infradev' }))
      ).rejects.toMatchObject({
        outcome: 'failed',
        message: 'all applies every environment; it takes no environment'
      })
    })

    test('refuses an environment that is not in the registry', async () => {
      headOfMain(DEPLOYMENTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))

      await expect(
        resolveApply(input({ AIP_ENVIRONMENT: 'sandbox' }))
      ).rejects.toMatchObject({ message: 'sandbox is not in the registry' })
    })
  })

  describe('for the tenants state', () => {
    function tenantsInput() {
      return input(
        { AIP_STATE: 'tenants', AIP_ENVIRONMENT: 'infradev' },
        { repo: 'ai-platform-tenants', eventName: 'workflow_dispatch' }
      )
    }

    function pinCommittedIn(sha) {
      nock(API)
        .get(`${DEPLOYMENTS}/commits`)
        .query({
          path: 'environments/infradev/platform.json',
          sha: 'main',
          per_page: '1'
        })
        .reply(200, [{ sha }])
    }

    test('applies once the platform apply covers the pin (R5)', async () => {
      headOfMain(TENANTS)
      environmentsRepo()
      pinOnMain()
      pinCommittedIn('p1')
      latestPlatformDeployment('p2')
      nock(API)
        .get(`${DEPLOYMENTS}/compare/p1...p2`)
        .query(true)
        .reply(200, comparison({ status: 'ahead' }))

      await expect(resolveApply(tenantsInput())).resolves.toEqual({
        matrix: [INFRADEV_LEG]
      })
    })

    test('waits for the platform apply of a newer pin (R5)', async () => {
      headOfMain(TENANTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))
      pinOnMain()
      pinCommittedIn('p2')
      latestPlatformDeployment('p1')
      nock(API)
        .get(`${DEPLOYMENTS}/compare/p2...p1`)
        .query(true)
        .reply(200, comparison({ status: 'behind' }))

      await expect(resolveApply(tenantsInput())).resolves.toEqual({
        matrix: []
      })
    })

    test('waits while the platform has never been applied (R5)', async () => {
      headOfMain(TENANTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))
      pinOnMain()
      pinCommittedIn('p1')
      latestPlatformDeployment(null)

      await expect(resolveApply(tenantsInput())).resolves.toEqual({
        matrix: []
      })
    })

    test('waits when the latest platform apply failed, even after an earlier success (R5)', async () => {
      headOfMain(TENANTS)
      nock(API)
        .get(`${ENVIRONMENTS}/contents/registry.json`)
        .query(true)
        .reply(200, fileContent(registry()))
      pinOnMain()
      pinCommittedIn('p1')
      latestPlatformDeployment('p1', 'failure')

      await expect(resolveApply(tenantsInput())).resolves.toEqual({
        matrix: []
      })
    })
  })

  test('refuses an unknown state', async () => {
    await expect(
      resolveApply(input({ AIP_STATE: 'everything' }))
    ).rejects.toMatchObject({ outcome: 'failed' })
  })
})

describe('preflight', () => {
  function input() {
    return commandInput(
      { env: { AIP_ENVIRONMENT: 'infradev' } },
      { repo: 'ai-platform-tenants' }
    )
  }

  // The repository has both machine rulesets as the design has them.
  function rulesetsAsDesigned(repo = TENANTS) {
    nock(API)
      .get(`${repo}/rulesets`)
      .query(true)
      .reply(200, [
        { id: 1, name: 'aip-machine-main', source_type: 'Repository' },
        { id: 2, name: 'aip-machine-protect', source_type: 'Repository' }
      ])
    nock(API)
      .get(`${repo}/rulesets/1`)
      .query(true)
      .reply(200, {
        enforcement: 'active',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [
          { actor_id: 111, actor_type: 'Integration', bypass_mode: 'always' }
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
            parameters: {
              required_status_checks: [
                {
                  context: 'validate-desired-state / validate',
                  integration_id: 15368
                }
              ]
            }
          }
        ]
      })
    nock(API)
      .get(`${repo}/rulesets/2`)
      .query(true)
      .reply(200, {
        enforcement: 'active',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [],
        rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }]
      })
    nock(API).get('/apps/ai-platform-orchestrator').reply(200, { id: 111 })
    nock(API).get('/apps/ai-platform-orchestrator-infradev').reply(404)
  }

  test('exports the commit of the last successful apply as AIP_BASE', async () => {
    headOfMain(TENANTS)
    rulesetsAsDesigned()
    lastDeployment(TENANTS, 'b1')

    await expect(preflight(input())).resolves.toEqual({ base: 'b1' })
    expect(exportedVariables()).toEqual({ AIP_BASE: 'b1' })
  })

  test('exports an empty AIP_BASE before the first apply', async () => {
    headOfMain(TENANTS)
    rulesetsAsDesigned()
    lastDeployment(TENANTS, null)

    await preflight(input())

    expect(exportedVariables()).toEqual({ AIP_BASE: '' })
  })

  test('refuses a run whose commit is no longer the head of main (R1)', async () => {
    headOfMain(TENANTS, 'f'.repeat(40))

    await expect(preflight(input())).rejects.toMatchObject({
      outcome: 'superseded',
      message: expect.stringContaining('Re-runs are refused (R1)')
    })
  })

  test('refuses to run when a machine ruleset is missing, before it reads what was last applied', async () => {
    headOfMain(TENANTS)
    nock(API)
      .get(`${TENANTS}/rulesets`)
      .query(true)
      .reply(200, [
        { id: 2, name: 'aip-machine-protect', source_type: 'Repository' }
      ])

    await expect(preflight(input())).rejects.toMatchObject({
      outcome: 'rulesets-changed',
      message: expect.stringContaining('aip-machine-main is missing')
    })
    expect(exportedVariables()).toEqual({})
  })

  test('does not read the rulesets of a superseded run', async () => {
    headOfMain(TENANTS, 'f'.repeat(40))

    await expect(preflight(input())).rejects.toMatchObject({
      outcome: 'superseded'
    })
    expect(nock.pendingMocks()).toEqual([])
  })
})

describe('dispatchApply', () => {
  test('starts the apply of each environment and records the runs', async () => {
    const started = nock(API)
      .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`, {
        ref: 'main',
        inputs: { environment: 'infradev', reason: 'platform apply run 1' }
      })
      .reply(200, dispatchedRun(88))

    await expect(
      dispatchApply(
        commandInput(
          {
            env: {
              AIP_TARGET: 'tenants',
              AIP_ENVIRONMENTS: '[\n  "infradev"\n]',
              AIP_REASON: 'platform apply run 1'
            }
          },
          { repo: 'ai-platform-deployments' }
        )
      )
    ).resolves.toEqual({
      runs: [
        {
          environment: 'infradev',
          url: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/88'
        }
      ]
    })
    expect(started.isDone()).toBe(true)
    expect(jobSummary()).toContain('actions/runs/88')
  })

  test('records a run GitHub did not name, with no reason', async () => {
    nock(API)
      .post(`${DEPLOYMENTS}/actions/workflows/apply.yml/dispatches`, {
        ref: 'main',
        inputs: { environment: 'infradev', reason: '' }
      })
      .reply(204)

    await expect(
      dispatchApply(
        commandInput(
          {
            env: { AIP_TARGET: 'deployments', AIP_ENVIRONMENTS: '["infradev"]' }
          },
          { repo: 'ai-platform-deployments' }
        )
      )
    ).resolves.toEqual({ runs: [{ environment: 'infradev', url: null }] })
    expect(jobSummary()).toContain('- `infradev`: started')
  })

  test('refuses a target that is not a state repository', async () => {
    await expect(
      dispatchApply(
        commandInput({ env: { AIP_TARGET: 'infra', AIP_ENVIRONMENTS: '[]' } })
      )
    ).rejects.toMatchObject({ outcome: 'failed' })
  })
})
