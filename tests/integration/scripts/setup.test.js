import { createWorkspace } from '../../helpers/scripts.js'

let workspace

beforeEach(() => {
  workspace = createWorkspace()
})

afterEach(() => workspace.cleanup())

function infra({ minWorkflowsVersion = '0.0.0', terraform = '1.16.5' } = {}) {
  workspace.write('infra/compat.json', JSON.stringify({ minWorkflowsVersion }))
  workspace.write('infra/.terraform-version', `${terraform}\n`)
}

describe('setup.sh', () => {
  test('exports the tool locations and outputs the Terraform version', () => {
    infra()

    const result = workspace.run('setup.sh', [], { AIP_INFRA: 'infra' })

    expect(result.status).toBe(0)
    expect(workspace.outputs()).toEqual({ 'terraform-version': '1.16.5' })
    expect(workspace.exported()).toMatchObject({
      AIP_INFRA: expect.stringMatching(/\/infra$/),
      AIP_SCRIPTS: expect.stringMatching(/\/scripts$/),
      AIP_CHECKS: expect.stringMatching(
        /\/infra\/checks\/bin\/aip-checks\.js$/
      ),
      TF_PLUGIN_CACHE_DIR: expect.stringMatching(/\/terraform-plugins$/),
      TF_IN_AUTOMATION: 'true',
      TF_INPUT: 'false'
    })
  })

  test('fails fast when the infra commit needs a newer workflows release', () => {
    infra({ minWorkflowsVersion: '99.0.0' })

    const result = workspace.run('setup.sh', [], { AIP_INFRA: 'infra' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-infra at this commit needs ai-platform-workflows 99.0.0 or later'
    )
    expect(workspace.exported()).toEqual({})
  })

  test('refuses a .terraform-version that holds no version', () => {
    infra({ terraform: 'latest' })

    const result = workspace.run('setup.sh', [], { AIP_INFRA: 'infra' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::.terraform-version does not hold a Terraform version'
    )
  })
})
