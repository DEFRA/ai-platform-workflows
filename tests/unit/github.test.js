import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import nock from 'nock'

import {
  changedPaths,
  dispatchWorkflow,
  folderExists,
  includesCommit,
  lastApplied,
  readFile,
  readJson,
  tagCommit,
  verifyRelease,
  withApiVersion,
  writeEnvironmentsConfig
} from '../../src/github.js'
import {
  annotatedTag,
  comparison,
  deployment,
  deploymentStatuses,
  dispatchedRun,
  fileContent,
  folderContent,
  gitRef
} from '../fixtures/github-api.js'
import { API, createOctokit, OWNER } from '../helpers/github.js'

const REPO = { owner: OWNER, repo: 'ai-platform-tenants' }
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`

describe('withApiVersion', () => {
  test('sends the contract API version with every request', async () => {
    const scope = nock(API, {
      reqheaders: { 'x-github-api-version': '2026-03-10' }
    })
      .get(`${TENANTS}/git/ref/heads%2Fmain`)
      .reply(200, gitRef('a'.repeat(40)))

    await withApiVersion(createOctokit()).rest.git.getRef({
      ...REPO,
      ref: 'heads/main'
    })

    expect(scope.isDone()).toBe(true)
  })
})

describe('readFile', () => {
  test('decodes the file at the ref', async () => {
    nock(API)
      .get(`${TENANTS}/contents/environments%2Finfradev%2Falpha.json`)
      .query({ ref: 'main' })
      .reply(200, fileContent('{"revision":3}\n'))

    await expect(
      readFile(createOctokit(), {
        ...REPO,
        path: 'environments/infradev/alpha.json',
        ref: 'main'
      })
    ).resolves.toBe('{"revision":3}\n')
  })

  test('is null for a file that does not exist', async () => {
    nock(API).get(`${TENANTS}/contents/missing.json`).query(true).reply(404)

    await expect(
      readFile(createOctokit(), { ...REPO, path: 'missing.json', ref: 'main' })
    ).resolves.toBeNull()
  })

  test('surfaces any other failure', async () => {
    nock(API).get(`${TENANTS}/contents/a.json`).query(true).reply(403, {})

    await expect(
      readFile(createOctokit(), { ...REPO, path: 'a.json', ref: 'main' })
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('readJson', () => {
  test('parses the file', async () => {
    nock(API)
      .get(`${TENANTS}/contents/a.json`)
      .query(true)
      .reply(200, fileContent({ revision: 3 }))

    await expect(
      readJson(createOctokit(), { ...REPO, path: 'a.json', ref: 'main' })
    ).resolves.toEqual({ revision: 3 })
  })
})

describe('folderExists', () => {
  test('is true for a folder with files', async () => {
    nock(API)
      .get(`${TENANTS}/contents/environments%2Finfradev`)
      .query(true)
      .reply(200, folderContent())

    await expect(
      folderExists(createOctokit(), {
        ...REPO,
        path: 'environments/infradev',
        ref: 'main'
      })
    ).resolves.toBe(true)
  })

  test('is false for a folder that does not exist', async () => {
    nock(API)
      .get(`${TENANTS}/contents/environments%2Fsandbox`)
      .query(true)
      .reply(404)

    await expect(
      folderExists(createOctokit(), {
        ...REPO,
        path: 'environments/sandbox',
        ref: 'main'
      })
    ).resolves.toBe(false)
  })
})

describe('lastApplied', () => {
  function deployments(list) {
    nock(API)
      .get(`${TENANTS}/deployments`)
      .query({ environment: 'infradev', per_page: '30' })
      .reply(200, list)
  }

  function status(id, state) {
    nock(API)
      .get(`${TENANTS}/deployments/${id}/statuses`)
      .query({ per_page: '1' })
      .reply(200, deploymentStatuses(state))
  }

  test('is the commit of the newest deployment that succeeded', async () => {
    deployments([deployment(3, 'c3'), deployment(2, 'c2'), deployment(1, 'c1')])
    status(3, 'failure')
    status(2, 'success')

    await expect(
      lastApplied(createOctokit(), { ...REPO, environment: 'infradev' })
    ).resolves.toBe('c2')
  })

  test('counts a deployment a later success made inactive', async () => {
    deployments([deployment(2, 'c2')])
    status(2, 'inactive')

    await expect(
      lastApplied(createOctokit(), { ...REPO, environment: 'infradev' })
    ).resolves.toBe('c2')
  })

  test('is null before the first successful apply', async () => {
    deployments([deployment(1, 'c1')])
    status(1, 'error')

    await expect(
      lastApplied(createOctokit(), { ...REPO, environment: 'infradev' })
    ).resolves.toBeNull()
  })
})

describe('changedPaths', () => {
  test('lists every changed path, a rename at both ends', async () => {
    nock(API)
      .get(`${TENANTS}/compare/b1...h1`)
      .query({ per_page: '1' })
      .reply(
        200,
        comparison({
          files: [
            'environments/infradev/alpha.json',
            {
              filename: 'environments/infradev/beta.json',
              previous_filename: 'environments/infradev/gamma.json'
            }
          ]
        })
      )

    await expect(
      changedPaths(createOctokit(), { ...REPO, base: 'b1', head: 'h1' })
    ).resolves.toEqual([
      'environments/infradev/alpha.json',
      'environments/infradev/beta.json',
      'environments/infradev/gamma.json'
    ])
  })

  test('is null when the comparison is too large to list', async () => {
    nock(API)
      .get(`${TENANTS}/compare/b1...h1`)
      .query(true)
      .reply(
        200,
        comparison({
          files: Array.from({ length: 300 }, (_, i) => `file-${i}.json`)
        })
      )

    await expect(
      changedPaths(createOctokit(), { ...REPO, base: 'b1', head: 'h1' })
    ).resolves.toBeNull()
  })
})

describe('includesCommit', () => {
  test('is true for a later commit', async () => {
    nock(API)
      .get(`${TENANTS}/compare/b1...h1`)
      .query(true)
      .reply(200, comparison({ status: 'ahead' }))

    await expect(
      includesCommit(createOctokit(), { ...REPO, base: 'b1', head: 'h1' })
    ).resolves.toBe(true)
  })

  test('is false for an earlier commit', async () => {
    nock(API)
      .get(`${TENANTS}/compare/b1...h1`)
      .query(true)
      .reply(200, comparison({ status: 'behind' }))

    await expect(
      includesCommit(createOctokit(), { ...REPO, base: 'b1', head: 'h1' })
    ).resolves.toBe(false)
  })

  test('is true for the same commit without asking GitHub', async () => {
    await expect(
      includesCommit(createOctokit(), { ...REPO, base: 'c1', head: 'c1' })
    ).resolves.toBe(true)
  })
})

describe('tagCommit', () => {
  test('is the commit a lightweight tag points to', async () => {
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv0.4.0`)
      .reply(200, gitRef('c'.repeat(40)))

    await expect(
      tagCommit(createOctokit(), {
        owner: OWNER,
        repo: 'ai-platform-infra',
        tag: 'v0.4.0'
      })
    ).resolves.toBe('c'.repeat(40))
  })

  test('follows an annotated tag to its commit', async () => {
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv0.4.0`)
      .reply(200, gitRef('d'.repeat(40), 'tag'))
    nock(API)
      .get(`${INFRA}/git/tags/${'d'.repeat(40)}`)
      .reply(200, annotatedTag('c'.repeat(40)))

    await expect(
      tagCommit(createOctokit(), {
        owner: OWNER,
        repo: 'ai-platform-infra',
        tag: 'v0.4.0'
      })
    ).resolves.toBe('c'.repeat(40))
  })
})

describe('verifyRelease', () => {
  const SHA = 'c'.repeat(40)

  test('accepts a tag that resolves to the pinned SHA', async () => {
    nock(API).get(`${INFRA}/git/ref/tags%2Fv0.4.0`).reply(200, gitRef(SHA))

    await expect(
      verifyRelease(createOctokit(), OWNER, { release: 'v0.4.0', sha: SHA })
    ).resolves.toBeUndefined()
  })

  test('refuses a tag that resolves elsewhere', async () => {
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv0.4.0`)
      .reply(200, gitRef('e'.repeat(40)))

    await expect(
      verifyRelease(createOctokit(), OWNER, { release: 'v0.4.0', sha: SHA })
    ).rejects.toThrow(`v0.4.0 resolves to ${'e'.repeat(40)}, not the pinned`)
  })

  test('accepts a SHA pin that repeats its SHA', async () => {
    await expect(
      verifyRelease(createOctokit(), OWNER, { release: SHA, sha: SHA })
    ).resolves.toBeUndefined()
  })

  test.each([
    [{ release: 'e'.repeat(40), sha: SHA }, 'a SHA pin repeats its sha'],
    [{ release: 'latest', sha: SHA }, 'is not a tag vX.Y.Z or SHA'],
    [{ release: 'v0.4.0', sha: 'main' }, 'is not a commit SHA']
  ])('refuses the inconsistent pin %o', async (pin, message) => {
    await expect(verifyRelease(createOctokit(), OWNER, pin)).rejects.toThrow(
      message
    )
  })
})

describe('dispatchWorkflow', () => {
  test('starts the workflow on main and returns the run', async () => {
    nock(API)
      .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`, {
        ref: 'main',
        inputs: { environment: 'infradev', reason: 'test' }
      })
      .reply(200, dispatchedRun(77))

    await expect(
      dispatchWorkflow(createOctokit(), {
        ...REPO,
        workflow: 'apply.yml',
        inputs: { environment: 'infradev', reason: 'test' }
      })
    ).resolves.toBe(
      'https://github.com/DEFRA/ai-platform-tenants/actions/runs/77'
    )
  })

  test('names a disabled target workflow as the outcome, and never re-enables it', async () => {
    nock(API)
      .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`)
      .reply(422, {
        message: "Cannot trigger a 'workflow_dispatch' on a disabled workflow",
        documentation_url:
          'https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event'
      })

    await expect(
      dispatchWorkflow(createOctokit(), {
        ...REPO,
        workflow: 'apply.yml',
        inputs: {}
      })
    ).rejects.toMatchObject({
      outcome: 'workflow-disabled',
      message: `${OWNER}/ai-platform-tenants apply.yml is disabled; enable it in that repository's Actions tab, then dispatch again`
    })
    expect(nock.pendingMocks()).toEqual([])
  })

  test('surfaces any other dispatch failure as it is', async () => {
    nock(API)
      .post(`${TENANTS}/actions/workflows/apply.yml/dispatches`)
      .reply(422, { message: 'Required input environment not provided' })

    await expect(
      dispatchWorkflow(createOctokit(), {
        ...REPO,
        workflow: 'apply.yml',
        inputs: {}
      })
    ).rejects.toMatchObject({ status: 422, name: 'HttpError' })
  })
})

describe('writeEnvironmentsConfig', () => {
  test('copies the shared and environment parameters from main', async () => {
    for (const [path, text] of [
      ['registry.json', '{"schemaVersion":1}\n'],
      ['global.tfvars.json', '{"location":"uksouth"}\n'],
      [
        'environments%2Finfradev%2Fplatform.tfvars.json',
        '{"environment":"infradev"}\n'
      ]
    ]) {
      nock(API)
        .get(`${ENVIRONMENTS}/contents/${path}`)
        .query({ ref: 'main' })
        .reply(200, fileContent(text))
    }
    const dir = join(process.env.RUNNER_TEMP, 'config')

    await writeEnvironmentsConfig(createOctokit(), {
      owner: OWNER,
      environments: ['infradev'],
      dir
    })

    expect(
      readFileSync(
        join(dir, 'environments', 'infradev', 'platform.tfvars.json'),
        'utf8'
      )
    ).toBe('{"environment":"infradev"}\n')
    expect(readFileSync(join(dir, 'global.tfvars.json'), 'utf8')).toBe(
      '{"location":"uksouth"}\n'
    )
  })

  test('refuses an environment without parameters', async () => {
    nock(API)
      .get(`${ENVIRONMENTS}/contents/registry.json`)
      .query(true)
      .reply(200, fileContent('{}'))
    nock(API)
      .get(`${ENVIRONMENTS}/contents/global.tfvars.json`)
      .query(true)
      .reply(200, fileContent('{}'))
    nock(API)
      .get(
        `${ENVIRONMENTS}/contents/environments%2Fsandbox%2Fplatform.tfvars.json`
      )
      .query(true)
      .reply(404)

    await expect(
      writeEnvironmentsConfig(createOctokit(), {
        owner: OWNER,
        environments: ['sandbox'],
        dir: join(process.env.RUNNER_TEMP, 'config')
      })
    ).rejects.toThrow(
      'ai-platform-environments has no environments/sandbox/platform.tfvars.json'
    )
  })
})
