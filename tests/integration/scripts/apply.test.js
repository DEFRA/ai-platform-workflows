import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

const GUID = '6c3f7a1e-2b4d-4e8f-9a0b-1c2d3e4f5a6b'
const HEAD = '1'.repeat(40)
const LEASE = '0d4e9c1a-7b3f-4e2d-8a6c-5f1e2d3c4b5a'

let workspace

beforeEach(() => {
  workspace = createWorkspace()
  workspace.write('config/global.tfvars.json', '{}\n')
  workspace.write('config/environments/infradev/platform.tfvars.json', '{}\n')
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
      /-var release=v0\.4\.0 -var entra_enabled=true -var-file=.*\/config\/global\.tfvars\.json -var-file=.*\/config\/environments\/infradev\/platform\.tfvars\.json$/
    )
    expect(command('checks plan-guard')).toEqual([
      'checks plan-guard --plan plan.json --state platform'
    ])
    expect(
      JSON.parse(readFileSync(join(workspace.dir, 'names.tfvars.json'), 'utf8'))
        .config_files
    ).toEqual([
      expect.stringMatching(/\/config\/global\.tfvars\.json$/),
      expect.stringMatching(
        /\/config\/environments\/infradev\/platform\.tfvars\.json$/
      )
    ])
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
      '-var environment=infradev -var platform_state={"container_name":"tfstate",' +
        '"resource_group_name":"SNDAIPINFRGP1402","storage_account_name":"sndaipinfsto1401",' +
        '"key":"platform.tfstate"}'
    )
    expect(command('checks plan-guard')).toEqual([
      `checks plan-guard --plan plan.json --state tenants --repo state --head ${HEAD} --environment infradev --base b1`
    ])
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
        /\/platform apply -input=false -lock-timeout=15m -json tfplan$/
      )
    ])
    expect(readFileSync(join(workspace.dir, 'apply.jsonl'), 'utf8')).toContain(
      'Apply complete!'
    )
  })

  test('fails when Terraform fails', () => {
    expect(run('apply', { AIP_TEST_FAIL: 'apply -input' }).status).toBe(1)
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
  })

  test('reports a run that never initialised Terraform', () => {
    const result = run('report', { AIP_OUTCOME: 'failure' })

    expect(result.status).toBe(0)
    expect(command('terraform')).toEqual([])
    expect(command('checks run-report')[0]).toMatch(
      /--out run-report-infradev\.json$/
    )
  })
})

test('apply.sh explains how to call it', () => {
  const result = run('destroy')

  expect(result.status).toBe(2)
  expect(result.stderr).toContain('usage: apply.sh plan|apply|report')
})
