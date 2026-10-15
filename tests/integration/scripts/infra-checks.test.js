import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

let workspace

beforeEach(() => {
  workspace = createWorkspace()

  // The workspace is the ai-platform-infra checkout.
  for (const folder of [
    'platform/tests',
    'tenants',
    'names/tests',
    'modules/naming/tests',
    'checks/tests',
    'platform/.terraform/modules/x/tests'
  ]) {
    mkdirSync(join(workspace.dir, folder), { recursive: true })
  }
})

afterEach(() => workspace.cleanup())

function terraformCalls() {
  return workspace.commands().map((line) => line.replace(/^terraform /, ''))
}

describe('infra-checks.sh', () => {
  test('checks the format, validates every root and tests with mock providers', () => {
    const result = workspace.run('infra-checks.sh')

    expect(result.status).toBe(0)
    expect(terraformCalls()).toEqual([
      'fmt -check -recursive',
      '-chdir=platform init -backend=false -input=false -lockfile=readonly',
      '-chdir=platform validate',
      '-chdir=tenants init -backend=false -input=false -lockfile=readonly',
      '-chdir=tenants validate',
      '-chdir=names init -backend=false -input=false -lockfile=readonly',
      '-chdir=names validate',
      '-chdir=./modules/naming init -backend=false -input=false',
      '-chdir=./modules/naming test',
      '-chdir=./names init -backend=false -input=false',
      '-chdir=./names test',
      '-chdir=./platform init -backend=false -input=false',
      '-chdir=./platform test'
    ])
  })

  test('stops at the first failure', () => {
    const result = workspace.run('infra-checks.sh', [], {
      AIP_TEST_FAIL: 'fmt'
    })

    expect(result.status).toBe(1)
    expect(terraformCalls()).toEqual(['fmt -check -recursive'])
  })
})
