import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

const PATH = 'environments/infradev/alpha.json'

let workspace

function commitOnMain(files) {
  spawnSync('git', [
    'init',
    '--quiet',
    '--initial-branch=main',
    join(workspace.dir, 'state')
  ])

  for (const [path, text] of Object.entries(files)) {
    workspace.write(`state/${path}`, text)
  }

  workspace.git('add', '--all')
  workspace.git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '--message',
    'main'
  )

  return workspace.git('rev-parse', 'HEAD')
}

function teamFile(revision) {
  return `{\n  "revision": ${revision}\n}\n`
}

beforeEach(() => {
  workspace = createWorkspace()
  workspace.write('config/registry.json', '{}\n')
})

afterEach(() => workspace.cleanup())

describe('desired-state.sh validate', () => {
  test('runs the checks between the pull request base and head', () => {
    const result = workspace.run('desired-state.sh', ['validate'], {
      AIP_KIND: 'tenants',
      AIP_INFRA: workspace.path('infra'),
      AIP_BASE_SHA: 'b1',
      AIP_HEAD_SHA: 'h1',
      AIP_AUTHOR: 'ai-platform-orchestrator[bot]',
      AIP_LABELS: 'gitops,env:infradev',
      AIP_APPROVERS: 'engineer-1',
      AIP_OPERATION_ID: 'op-00000001'
    })

    expect(result.status).toBe(0)
    expect(workspace.commands()).toEqual([
      expect.stringMatching(
        /^checks tenants --repo state --base b1 --head h1 --infra .*\/infra --environments .*\/config --author ai-platform-orchestrator\[bot\] --labels gitops,env:infradev --approvers engineer-1 --operation-id op-00000001$/
      )
    ])
  })

  test('fails the check when the checks fail', () => {
    const result = workspace.run('desired-state.sh', ['validate'], {
      AIP_KIND: 'pins',
      AIP_INFRA: workspace.path('infra'),
      AIP_BASE_SHA: 'b1',
      AIP_HEAD_SHA: 'h1',
      AIP_AUTHOR: 'an-engineer',
      AIP_TEST_FAIL: 'pins'
    })

    expect(result.status).toBe(1)
  })
})

describe('desired-state.sh stage', () => {
  function stage(env) {
    return workspace.run('desired-state.sh', ['stage'], {
      AIP_KIND: 'tenants',
      AIP_INFRA: workspace.path('infra'),
      AIP_AUTHOR: 'ai-platform-orchestrator[bot]',
      AIP_ACTION: 'write',
      AIP_PATH: PATH,
      AIP_DOCUMENT_FILE: workspace.path('document.json'),
      AIP_EXPECTED_REVISION: '1',
      AIP_OPERATION_ID: 'op-00000001',
      AIP_RELEASE: 'v0.4.0',
      ...env
    })
  }

  test('commits the document on main and validates the change', () => {
    const main = commitOnMain({ [PATH]: teamFile(1) })
    workspace.write('document.json', teamFile(2))

    const result = stage()

    expect(result.status).toBe(0)
    const head = workspace.git('rev-parse', 'HEAD')
    expect(workspace.git('show', `HEAD:${PATH}`)).toBe(teamFile(2).trim())
    expect(workspace.commands()).toEqual([
      expect.stringContaining(
        `checks tenants --repo state --base ${main} --head ${head} `
      )
    ])
    expect(workspace.commands()[0]).toMatch(/--operation-id op-00000001$/)
    expect(workspace.exported()).toEqual({ AIP_MAIN_SHA: main })
  })

  test('adds a new team file at revision 0', () => {
    commitOnMain({ 'README.md': 'state\n' })
    workspace.write('document.json', teamFile(1))

    expect(stage({ AIP_EXPECTED_REVISION: '0' }).status).toBe(0)
  })

  test('removes a team file', () => {
    commitOnMain({ [PATH]: teamFile(1) })

    const result = stage({ AIP_ACTION: 'remove', AIP_DOCUMENT_FILE: '' })

    expect(result.status).toBe(0)
    expect(workspace.git('ls-files', PATH)).toBe('')
  })

  test('refuses a revision that does not match main', () => {
    commitOnMain({ [PATH]: teamFile(3) })
    workspace.write('document.json', teamFile(2))

    const result = stage()

    expect(result.status).toBe(1)
    expect(workspace.summary()).toBe(
      `### revision-conflict\n\nmain has revision 3 of ${PATH}, not 1\n`
    )
    expect(workspace.commands()).toEqual([])
  })

  test('ignores the revision of a pin', () => {
    const pinPath = 'environments/infradev/platform.json'
    commitOnMain({ [pinPath]: '{"release":"v0.3.0"}\n' })
    workspace.write('document.json', '{"release":"v0.4.0"}\n')

    const result = stage({
      AIP_KIND: 'pins',
      AIP_PATH: pinPath,
      AIP_EXPECTED_REVISION: '0'
    })

    expect(result.status).toBe(0)
  })

  test('refuses a document main already holds', () => {
    commitOnMain({ [PATH]: teamFile(1) })
    workspace.write('document.json', teamFile(1))

    const result = stage()

    expect(result.status).toBe(1)
    expect(workspace.summary()).toContain(
      `### checks-failed\n\n${PATH} on main already holds this document`
    )
  })

  test('refuses to remove a file main does not have', () => {
    commitOnMain({ 'README.md': 'state\n' })

    const result = stage({ AIP_ACTION: 'remove', AIP_EXPECTED_REVISION: '0' })

    expect(result.status).toBe(1)
    expect(workspace.summary()).toContain(`${PATH} does not exist on main`)
  })

  test('reports a change that fails validation as checks-failed', () => {
    commitOnMain({ [PATH]: teamFile(1) })
    workspace.write('document.json', teamFile(2))

    const result = stage({ AIP_TEST_FAIL: 'tenants' })

    expect(result.status).toBe(1)
    expect(workspace.summary()).toContain(
      '### checks-failed\n\nthe change failed validation at v0.4.0'
    )
    expect(workspace.exported()).toEqual({})
  })
})

test('desired-state.sh explains how to call it', () => {
  const result = workspace.run('desired-state.sh', ['apply'], {
    AIP_KIND: 'tenants'
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toContain('usage: desired-state.sh validate|stage')
})
