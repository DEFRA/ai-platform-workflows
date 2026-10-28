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

  test('refuses a revision that does not match main, as stale so the request can be rebuilt', () => {
    commitOnMain({ [PATH]: teamFile(3) })
    workspace.write('document.json', teamFile(2))

    const result = stage()

    expect(result.status).toBe(3)
    expect(workspace.summary()).toBe(
      `### stale-revision\n\nmain has revision 3 of ${PATH}, not 1\n`
    )
    expect(workspace.exported()).toEqual({
      AIP_FAILURE_CODE: 'stale-revision',
      AIP_FAILURE_MESSAGE: `main has revision 3 of ${PATH}, not 1`
    })
    expect(workspace.commands()).toEqual([])
  })

  test('refuses a team file that is no longer new', () => {
    commitOnMain({ [PATH]: teamFile(1) })
    workspace.write('document.json', teamFile(1))

    expect(stage({ AIP_EXPECTED_REVISION: '0' }).status).toBe(3)
  })

  describe('a pin', () => {
    const PIN_PATH = 'environments/infradev/platform.json'
    const pinStage = (env) =>
      stage({
        AIP_KIND: 'pins',
        AIP_PATH: PIN_PATH,
        AIP_EXPECTED_REVISION: '0',
        ...env
      })

    test('commits when main still holds the blob the request names', () => {
      commitOnMain({ [PIN_PATH]: '{"release":"v0.3.0"}\n' })
      const blob = workspace.git('rev-parse', `HEAD:${PIN_PATH}`)
      workspace.write('document.json', '{"release":"v0.4.0"}\n')

      expect(pinStage({ AIP_EXPECTED_BASE: blob }).status).toBe(0)
    })

    test('commits a first pin that names 0 as its base', () => {
      commitOnMain({ 'README.md': 'state\n' })
      workspace.write('document.json', '{"release":"v0.4.0"}\n')

      expect(pinStage({ AIP_EXPECTED_BASE: '0' }).status).toBe(0)
    })

    test('is stale when the pin moved to another blob', () => {
      commitOnMain({ [PIN_PATH]: '{"release":"v0.3.0"}\n' })
      workspace.write('document.json', '{"release":"v0.4.0"}\n')

      const result = pinStage({ AIP_EXPECTED_BASE: 'a'.repeat(40) })

      expect(result.status).toBe(3)
      expect(workspace.summary()).toContain('### stale-revision')
      expect(workspace.summary()).toContain(`main has ${PIN_PATH} at `)
      expect(workspace.commands()).toEqual([])
    })

    test('is stale when a first pin finds one already on main', () => {
      commitOnMain({ [PIN_PATH]: '{"release":"v0.3.0"}\n' })
      workspace.write('document.json', '{"release":"v0.4.0"}\n')

      expect(pinStage({ AIP_EXPECTED_BASE: '0' }).status).toBe(3)
    })
  })

  test('writes the document of a revert as it does a write', () => {
    commitOnMain({ [PATH]: teamFile(3) })
    workspace.write('document.json', teamFile(2))

    const result = stage({ AIP_ACTION: 'revert', AIP_EXPECTED_REVISION: '3' })

    expect(result.status).toBe(0)
    expect(workspace.git('show', `HEAD:${PATH}`)).toBe(teamFile(2).trim())
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
    expect(workspace.exported()).toEqual({
      AIP_FAILURE_CODE: 'checks-failed',
      AIP_FAILURE_MESSAGE:
        'the change failed validation at v0.4.0; the log has the reasons'
    })
  })
})

describe('desired-state.sh restage', () => {
  const NEW_DOCUMENT = teamFile(2)

  // A state checkout cloned from an upstream whose main can move on.
  function cloned(files) {
    const upstream = workspace.path('upstream')
    spawnSync('git', ['init', '--quiet', '--initial-branch=main', upstream])
    for (const [path, text] of Object.entries(files)) {
      workspace.write(`upstream/${path}`, text)
    }
    upstreamGit('add', '--all')
    upstreamGit('commit', '--quiet', '--message', 'main')
    spawnSync('git', ['clone', '--quiet', upstream, workspace.path('state')])
  }

  function upstreamGit(...args) {
    const result = spawnSync(
      'git',
      [
        '-C',
        workspace.path('upstream'),
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@invalid',
        ...args
      ],
      { encoding: 'utf8' }
    )

    if (result.status !== 0) {
      throw new Error(result.stderr)
    }

    return result.stdout.trim()
  }

  function restage(env) {
    return workspace.run('desired-state.sh', ['restage'], {
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

  beforeEach(() => {
    workspace.write('document.json', NEW_DOCUMENT)
  })

  test('stages and validates the change on the head main moved to, and prints that head alone on stdout', () => {
    cloned({ [PATH]: teamFile(1) })
    workspace.write('upstream/README.md', 'moved on\n')
    upstreamGit('add', '--all')
    upstreamGit('commit', '--quiet', '--message', 'moved')
    const moved = upstreamGit('rev-parse', 'HEAD')

    const result = restage()

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`main-sha=${moved}\n`)
    expect(workspace.git('rev-parse', 'HEAD~1')).toBe(moved)
    expect(workspace.git('show', `HEAD:${PATH}`)).toBe(NEW_DOCUMENT.trim())
    expect(workspace.commands()).toEqual([
      expect.stringContaining(`checks tenants --repo state --base ${moved} `)
    ])
    expect(workspace.exported()).toEqual({ AIP_MAIN_SHA: moved })
  })

  test('starts again from main even when an earlier attempt left its staged commit', () => {
    cloned({ [PATH]: teamFile(1) })
    expect(
      workspace.run('desired-state.sh', ['stage'], {
        AIP_KIND: 'tenants',
        AIP_INFRA: workspace.path('infra'),
        AIP_AUTHOR: 'a[bot]',
        AIP_ACTION: 'write',
        AIP_PATH: PATH,
        AIP_DOCUMENT_FILE: workspace.path('document.json'),
        AIP_EXPECTED_REVISION: '1',
        AIP_OPERATION_ID: 'op-00000001',
        AIP_RELEASE: 'v0.4.0'
      }).status
    ).toBe(0)
    const main = upstreamGit('rev-parse', 'HEAD')

    const result = restage()

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`main-sha=${main}\n`)
  })

  test('is stale when the file moved on main, and prints no head', () => {
    cloned({ [PATH]: teamFile(1) })
    workspace.write(`upstream/${PATH}`, teamFile(2))
    upstreamGit('add', '--all')
    upstreamGit('commit', '--quiet', '--message', 'someone wrote it')
    workspace.write('document.json', teamFile(3))

    const result = restage()

    expect(result.status).toBe(3)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`main has revision 2 of ${PATH}, not 1`)
  })

  test('is checks-failed when the change no longer validates on the new head', () => {
    cloned({ [PATH]: teamFile(1) })

    const result = restage({ AIP_TEST_FAIL: 'tenants' })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  test('never prints the token it fetches with', () => {
    cloned({ [PATH]: teamFile(1) })

    const result = restage({ AIP_GIT_TOKEN: 'ghs_secret_token_value' })

    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('ghs_secret')
    expect(workspace.commands().join('\n')).not.toContain('ghs_secret')
  })
})

test('desired-state.sh explains how to call it', () => {
  const result = workspace.run('desired-state.sh', ['apply'], {
    AIP_KIND: 'tenants'
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toContain(
    'usage: desired-state.sh validate|stage|restage'
  )
})
