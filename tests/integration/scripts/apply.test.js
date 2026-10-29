import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

const GUID = '6c3f7a1e-2b4d-4e8f-9a0b-1c2d3e4f5a6b'
const HEAD = '1'.repeat(40)
const LEASE = '0d4e9c1a-7b3f-4e2d-8a6c-5f1e2d3c4b5a'
const CDP = {
  issuer:
    'https://00000000-0000-0000-0000-000000000000.tokens.sts.global.api.aws',
  awsAccount: '000000000000',
  audience: 'api://AzureADTokenExchange'
}
const APP = '7a1d2b3c-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const PRINCIPAL = '8b2e3c4d-5f6a-4b7c-9d8e-0f1a2b3c4d5e'

// A saved plan that removes one team's registration and service principal.
function removesRegistration() {
  return JSON.stringify({
    resource_changes: [
      {
        type: 'azuread_service_principal',
        change: { actions: ['delete'], before: { object_id: PRINCIPAL } }
      },
      {
        type: 'azuread_application',
        change: { actions: ['delete'], before: { object_id: APP } }
      },
      {
        type: 'azurerm_api_management_api',
        change: { actions: ['delete'], before: { name: 'beta' } }
      },
      {
        type: 'azuread_application',
        change: { actions: ['update'], before: { object_id: GUID } }
      }
    ]
  })
}

let workspace

beforeEach(() => {
  workspace = createWorkspace()
  workspace.write('config/global.tfvars.json', '{}\n')
  workspace.write('config/environments/infradev/platform.tfvars.json', '{}\n')
  workspace.write(
    'config/registry.json',
    JSON.stringify({
      environments: [{ name: 'infradev', cdp: { environment: 'dev', ...CDP } }]
    })
  )
  for (const root of ['names', 'platform', 'tenants']) {
    mkdirSync(join(workspace.dir, 'infra', root), { recursive: true })
  }
})

afterEach(() => workspace.cleanup())

function run(command, env = {}) {
  return workspace.run('apply.sh', [command], {
    AIP_STATE: 'platform',
    AIP_ENVIRONMENT: 'infradev',
    AIP_RELEASE: 'v0.4.0',
    AIP_ENTRA_ENABLED: 'true',
    AIP_TEAM_REGISTRATIONS: 'true',
    AIP_INFRA: workspace.path('infra'),
    AIP_CONFIG: 'config',
    AIP_BASE: '',
    AIP_BREAK_GLASS: 'false',
    ARM_CLIENT_ID: GUID,
    ARM_TENANT_ID: GUID,
    ARM_SUBSCRIPTION_ID: GUID,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com',
    GITHUB_SHA: HEAD,
    GITHUB_REPOSITORY: 'DEFRA/ai-platform-deployments',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_TRIGGERING_ACTOR: 'an-engineer',
    ...env
  })
}

function command(prefix) {
  return workspace.commands().filter((line) => line.startsWith(prefix))
}

describe('apply.sh plan', () => {
  test('re-validates the pin, initialises the CCoE-named backend and guards the plan', () => {
    const result = run('plan')

    expect(result.status).toBe(0)
    expect(command('checks pin-on-main')).toEqual([
      expect.stringMatching(
        new RegExp(
          `^checks pin-on-main --repo state --ref ${HEAD} --environment infradev --infra .*/infra --environments .*/config$`
        )
      )
    ])
    expect(
      command('terraform -chdir=').map((line) =>
        line.split(' ').slice(1, 3).join(' ')
      )
    ).toEqual([
      expect.stringMatching(/\/names init$/),
      expect.stringMatching(/\/names apply$/),
      expect.stringMatching(/\/names output$/),
      expect.stringMatching(/\/platform init$/),
      expect.stringMatching(/\/platform plan$/),
      expect.stringMatching(/\/platform show$/)
    ])
    expect(
      command('terraform -chdir=').find((line) =>
        line.includes('/platform init')
      )
    ).toContain(
      '-backend-config=resource_group_name=SNDAIPINFRGP1402 ' +
        '-backend-config=storage_account_name=sndaipinfsto1401 ' +
        '-backend-config=container_name=tfstate -backend-config=key=platform.tfstate'
    )
    expect(
      command('terraform -chdir=').find((line) =>
        line.includes('/platform plan')
      )
    ).toMatch(
      /plan -input=false -lock-timeout=15m -parallelism=20 -out=tfplan -var release=v0\.4\.0 -var entra_enabled=true -var-file=.*\/params\.tfvars\.json$/
    )
    expect(command('checks params')).toEqual([
      expect.stringMatching(
        /^checks params --infra .*\/infra --environments .*\/config --environment infradev --out .*\/params\.tfvars\.json$/
      )
    ])
    expect(command('checks plan-guard')).toEqual([
      'checks plan-guard --plan plan.json --state platform'
    ])
    expect(
      JSON.parse(readFileSync(join(workspace.dir, 'names.tfvars.json'), 'utf8'))
    ).toEqual({ params_file: expect.stringMatching(/\/params\.tfvars\.json$/) })
  })

  test('re-validates and bundles the team files for the tenants state', () => {
    const result = run('plan', { AIP_STATE: 'tenants', AIP_BASE: 'b1' })

    expect(result.status).toBe(0)
    expect(command('checks tenants-on-main')).toHaveLength(1)
    expect(command('checks teams-variables')).toEqual([
      expect.stringMatching(
        /--out .*\/infra\/tenants\/teams\.auto\.tfvars\.json$/
      )
    ])
    expect(
      command('terraform -chdir=').find((line) =>
        line.includes('/tenants plan')
      )
    ).toContain(
      `-var team_registrations=true -var environment=infradev -var cdp=${JSON.stringify(CDP)} ` +
        '-var platform_state={"container_name":"tfstate",' +
        '"resource_group_name":"SNDAIPINFRGP1402","storage_account_name":"sndaipinfsto1401",' +
        '"key":"platform.tfstate"}'
    )
    expect(command('checks plan-guard')).toEqual([
      `checks plan-guard --plan plan.json --state tenants --repo state --head ${HEAD} --environment infradev --base b1`
    ])
    expect(workspace.outputs()).toEqual({ entra_deletes: '0' })
  })

  test('passes only team_registrations to the tenants plan, never entra_enabled', () => {
    const result = run('plan', {
      AIP_STATE: 'tenants',
      AIP_BASE: 'b1',
      AIP_TEAM_REGISTRATIONS: 'false'
    })
    const plan = command('terraform -chdir=').find((line) =>
      line.includes('/tenants plan')
    )

    expect(result.status).toBe(0)
    expect(plan).toContain('-var team_registrations=false')
    expect(plan).not.toContain('entra_enabled')
  })

  test('counts the Entra objects the plan deletes, for the purge', () => {
    workspace.write('removes.json', removesRegistration())

    const result = run('plan', {
      AIP_STATE: 'tenants',
      AIP_TEST_PLAN: workspace.path('removes.json')
    })

    expect(result.status).toBe(0)
    expect(workspace.outputs()).toEqual({ entra_deletes: '2' })
  })

  test('refuses a tenants plan for an environment with no CDP trust', () => {
    workspace.write('config/registry.json', '{"environments":[]}')

    const result = run('plan', { AIP_STATE: 'tenants' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::registry.json has no cdp trust for infradev'
    )
    expect(command('terraform -chdir=').join('\n')).not.toContain(' plan ')
  })

  test.each([
    [{ ARM_CLIENT_ID: '' }, 'ARM_CLIENT_ID is not set'],
    [{ ARM_SUBSCRIPTION_ID: 'SND1' }, 'ARM_SUBSCRIPTION_ID is not set'],
    [
      { ACTIONS_ID_TOKEN_REQUEST_URL: '' },
      'the job needs permissions: id-token: write'
    ]
  ])('refuses to start without the OIDC sign-in (%o)', (env, message) => {
    const result = run('plan', env)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`::error::${message}`)
    expect(workspace.commands()).toEqual([])
  })

  test('refuses break-glass inputs that an engineer did not dispatch', () => {
    const result = run('plan', { AIP_ALLOW_DESTROY: 'true' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      "::error::allow_destroy is for an engineer's dispatch only"
    )
    expect(command('checks plan-guard')).toEqual([])
  })

  test('lets an engineer pass deletes through plan-guard, reported', () => {
    const result = run('plan', {
      AIP_ALLOW_DESTROY: 'true',
      AIP_BREAK_GLASS: 'true'
    })

    expect(result.status).toBe(0)
    expect(command('checks plan-guard')).toEqual([
      'checks plan-guard --plan plan.json --state platform --allow-destroy'
    ])
    expect(workspace.summary()).toContain(
      '### Break-glass: allow_destroy by an-engineer'
    )
  })

  test('lets an engineer break a state lease left by a lost runner (R6)', () => {
    const result = run('plan', {
      AIP_FORCE_UNLOCK: LEASE,
      AIP_BREAK_GLASS: 'true'
    })

    expect(result.status).toBe(0)
    expect(
      command('terraform -chdir=').some((line) =>
        line.endsWith(`force-unlock -force ${LEASE}`)
      )
    ).toBe(true)
    expect(workspace.summary()).toContain(
      `### Break-glass: force_unlock of lease ${LEASE}`
    )
  })

  test('refuses a force_unlock that is not a lease ID', () => {
    const result = run('plan', {
      AIP_FORCE_UNLOCK: '* -lock=false',
      AIP_BREAK_GLASS: 'true'
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::force_unlock takes the state lease ID'
    )
  })

  test('fails when plan-guard refuses the plan (R2)', () => {
    const result = run('plan', { AIP_TEST_FAIL: 'plan-guard' })

    expect(result.status).toBe(1)
  })
})

describe('apply.sh apply', () => {
  test('applies the saved plan and keeps the JSON log', () => {
    const result = run('apply')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Apply complete!')
    expect(command('terraform -chdir=')).toEqual([
      expect.stringMatching(
        /\/platform apply -input=false -lock-timeout=15m -parallelism=20 -json tfplan$/
      )
    ])
    expect(readFileSync(join(workspace.dir, 'apply.jsonl'), 'utf8')).toContain(
      'Apply complete!'
    )
  })

  test('streams the apply log as Terraform writes it, not when the apply is over', () => {
    const script = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'scripts', 'apply.sh'),
      'utf8'
    )

    expect(script).toContain(
      'tee apply.jsonl | jq --unbuffered -r \'."@message"\''
    )
  })

  test('fails when Terraform fails', () => {
    expect(run('apply', { AIP_TEST_FAIL: 'apply -input' }).status).toBe(1)
  })
})

describe('apply.sh purge', () => {
  function deletedItem(id) {
    return (
      'az rest --method delete ' +
      `--url https://graph.microsoft.com/v1.0/directory/deletedItems/${id} ` +
      '--only-show-errors'
    )
  }

  test('permanently deletes the Entra objects the apply removed', () => {
    workspace.write('plan.json', removesRegistration())

    const result = run('purge', { AIP_STATE: 'tenants' })

    expect(result.status).toBe(0)
    expect(command('az')).toEqual([deletedItem(PRINCIPAL), deletedItem(APP)])
    expect(result.stdout).toContain(`Permanently deleted Entra object ${APP}`)
  })

  test('warns, and still succeeds, when an object cannot be purged', () => {
    workspace.write('plan.json', removesRegistration())

    const result = run('purge', {
      AIP_STATE: 'tenants',
      AIP_TEST_FAIL: PRINCIPAL,
      AIP_RETRY_SECONDS: '0'
    })

    expect(result.status).toBe(0)
    expect(command('az')).toEqual([
      deletedItem(PRINCIPAL),
      deletedItem(PRINCIPAL),
      deletedItem(PRINCIPAL),
      deletedItem(APP)
    ])
    expect(result.stdout).toContain(
      `::warning::Entra object ${PRINCIPAL} is still in deleted items`
    )
  })
})

describe('apply.sh report', () => {
  test('reports the run from everything the earlier steps left', () => {
    workspace.write('plan.json', '{}')
    workspace.write('apply.jsonl', '{}')
    mkdirSync(join(workspace.dir, 'infra', 'platform', '.terraform'))

    const result = run('report', { AIP_OUTCOME: 'success', AIP_BASE: 'b1' })

    expect(result.status).toBe(0)
    expect(command('checks run-report')).toEqual([
      expect.stringContaining(
        '--outcome success --release v0.4.0 --repository DEFRA/ai-platform-deployments ' +
          '--run-id 123 --run-attempt 1 ' +
          '--run-url https://github.com/DEFRA/ai-platform-deployments/actions/runs/123 ' +
          '--out run-report-infradev.json --base b1 --plan plan.json --apply-log apply.jsonl --outputs outputs.json'
      )
    ])
    expect(workspace.summary()).toContain(
      '### success\n\nChanges: 2 to add, 1 to change, 0 to destroy\n\nOperations: op-00000001'
    )
    expect(workspace.summary()).toContain('Entra objects in this state: 4')
  })

  test('reports a run that never initialised Terraform', () => {
    const result = run('report', { AIP_OUTCOME: 'failure' })

    expect(result.status).toBe(0)
    expect(command('terraform')).toEqual([])
    expect(command('checks run-report')[0]).toMatch(
      /--out run-report-infradev\.json$/
    )
  })

  test('keeps the events publish-event put in the report, which the report step would otherwise overwrite', () => {
    const events = [
      { eventId: 'op-00000001:deploying:123:1', status: 'deploying' },
      { eventId: 'op-00000001:requested:123:1', status: 'requested' }
    ]
    workspace.write('run-report-infradev.json', JSON.stringify({ events }))

    const result = run('report', { AIP_OUTCOME: 'success' })

    expect(result.status).toBe(0)
    const report = JSON.parse(
      readFileSync(join(workspace.dir, 'run-report-infradev.json'), 'utf8')
    )
    expect(report.events).toEqual(events)
    expect(report.outcome).toBe('success')
    expect(report.operations).toEqual([{ operationIds: ['op-00000001'] }])
  })

  test('records a held apply as paused, keeping its deploy-failed event, which is what the backend and the reconciler read', () => {
    const events = [
      {
        eventId: 'op-00000001:deploy-failed:123:1',
        status: 'deploy-failed',
        failureReason: { code: 'paused', retryable: true }
      }
    ]
    workspace.write('run-report-infradev.json', JSON.stringify({ events }))

    const result = run('report', { AIP_OUTCOME: 'paused' })

    expect(result.status).toBe(0)
    const report = JSON.parse(
      readFileSync(join(workspace.dir, 'run-report-infradev.json'), 'utf8')
    )
    expect(report.outcome).toBe('paused')
    expect(report.events).toEqual(events)
    expect(workspace.summary()).toContain('### paused')
  })

  test('adds no events key to a report that had none', () => {
    run('report', { AIP_OUTCOME: 'success' })

    expect(
      JSON.parse(
        readFileSync(join(workspace.dir, 'run-report-infradev.json'), 'utf8')
      )
    ).not.toHaveProperty('events')
  })
})

describe('apply.sh operations', () => {
  test('writes a first report, before the plan, so the operations the apply carries are known', () => {
    const result = run('operations', { AIP_BASE: 'b1' })

    expect(result.status).toBe(0)
    expect(command('checks run-report')).toEqual([
      expect.stringContaining(
        '--outcome pending --release v0.4.0 --repository DEFRA/ai-platform-deployments ' +
          '--run-id 123 --run-attempt 1 ' +
          '--run-url https://github.com/DEFRA/ai-platform-deployments/actions/runs/123 ' +
          '--out run-report-infradev.json --base b1'
      )
    ])
    expect(command('checks run-report')[0]).not.toContain('--plan')
    expect(command('terraform')).toEqual([])
    expect(
      JSON.parse(
        readFileSync(join(workspace.dir, 'run-report-infradev.json'), 'utf8')
      ).operations
    ).toEqual([{ operationIds: ['op-00000001'] }])
    expect(workspace.summary()).toBe('')
  })

  test('keeps the events already in the report', () => {
    workspace.write(
      'run-report-infradev.json',
      JSON.stringify({ events: [{ eventId: 'x' }] })
    )

    run('operations')

    expect(
      JSON.parse(
        readFileSync(join(workspace.dir, 'run-report-infradev.json'), 'utf8')
      ).events
    ).toEqual([{ eventId: 'x' }])
  })
})

test('apply.sh explains how to call it', () => {
  const result = run('destroy')

  expect(result.status).toBe(2)
  expect(result.stderr).toContain(
    'usage: apply.sh plan|apply|purge|operations|report'
  )
})
