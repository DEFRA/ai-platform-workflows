import nock from 'nock'

import { adminCheck, EXEMPT_APPS, isExemptApp } from '../../src/admin.js'
import { API, commandInput, jobSummary, OWNER } from '../helpers/github.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const CALLER = `${OWNER}/ai-platform-tenants/.github/workflows/reconcile-all.yml@refs/heads/main`
const APP = 'ai-platform-orchestrator[bot]'

function permission(user, role) {
  return nock(API)
    .get(`${TENANTS}/collaborators/${user}/permission`)
    .reply(
      200,
      role === 'admin'
        ? { permission: 'admin', role_name: 'admin' }
        : { permission: 'write', role_name: role }
    )
}

function check(
  { scope = 'submit', actor, triggering = actor, env = {} },
  run = {}
) {
  return adminCheck(
    commandInput(
      {
        env: {
          AIP_ADMIN_SCOPE: scope,
          AIP_ACTOR: actor,
          AIP_TRIGGERING_ACTOR: triggering,
          AIP_WORKFLOW_REF: CALLER,
          ...env
        }
      },
      run
    )
  )
}

describe('the exempt Apps', () => {
  test('are exactly the three the contract names', () => {
    expect([...EXEMPT_APPS].sort()).toEqual([
      'ai-platform-orchestrator-infradev[bot]',
      'ai-platform-orchestrator[bot]',
      'ai-platform-release[bot]'
    ])
  })

  test('never include github-actions[bot], which GITHUB_TOKEN can start a dispatch as', () => {
    expect(isExemptApp('github-actions[bot]')).toBe(false)
    expect(isExemptApp('ai-platform-orchestrator[bot]')).toBe(true)
    expect(isExemptApp('ai-platform-orchestrator')).toBe(false)
  })
})

describe('adminCheck', () => {
  test.each(['push', 'schedule', 'pull_request'])(
    'does not check a %s run',
    async (eventName) => {
      await expect(
        check({ actor: 'someone' }, { eventName })
      ).resolves.toMatchObject({ outcome: 'not-dispatched' })
    }
  )

  test.each(['submit', 'apply'])(
    'lets an exempt App dispatch the %s, with no call to GitHub',
    async (scope) => {
      await expect(check({ scope, actor: APP })).resolves.toMatchObject({
        outcome: 'exempt-app'
      })
    }
  )

  test('lets an engineer re-run the failed jobs of a portal run, because the App started it', async () => {
    await expect(
      check({ scope: 'submit', actor: APP, triggering: 'someone' })
    ).resolves.toMatchObject({ outcome: 'exempt-app' })
  })

  test('refuses github-actions[bot] without asking GitHub', async () => {
    await expect(check({ actor: 'github-actions[bot]' })).rejects.toMatchObject(
      {
        outcome: 'not-admin',
        message: expect.stringContaining('github-actions[bot]')
      }
    )
  })

  test('lets a repository admin write by hand, checking both the actor and the one who re-ran it', async () => {
    const actor = permission('admin-a', 'admin')
    const triggering = permission('admin-b', 'admin')

    await expect(
      check({ actor: 'admin-a', triggering: 'admin-b' })
    ).resolves.toMatchObject({ outcome: 'admin' })
    expect(actor.isDone() && triggering.isDone()).toBe(true)
  })

  test('refuses a hand write by someone who can only push', async () => {
    permission('writer', 'write')

    await expect(check({ actor: 'writer' })).rejects.toMatchObject({
      outcome: 'not-admin',
      message: expect.stringContaining('writer')
    })
  })

  test("refuses a re-run of an admin's hand write by an engineer, who keeps the admin's privileges otherwise", async () => {
    permission('admin-a', 'admin')
    permission('writer', 'write')

    await expect(
      check({ actor: 'admin-a', triggering: 'writer' })
    ).rejects.toMatchObject({ outcome: 'not-admin' })
  })

  test('treats a person GitHub does not know on the repository as no admin', async () => {
    nock(API).get(`${TENANTS}/collaborators/stranger/permission`).reply(404)

    await expect(check({ actor: 'stranger' })).rejects.toMatchObject({
      outcome: 'not-admin'
    })
  })

  test('fails closed when GitHub cannot say', async () => {
    nock(API).get(`${TENANTS}/collaborators/someone/permission`).reply(500)

    await expect(check({ actor: 'someone' })).rejects.toMatchObject({
      status: 500
    })
  })

  test.each([
    ['allow_destroy or force_unlock is given', APP, 'true'],
    ['an engineer re-runs it', 'writer', 'true']
  ])(
    'refuses break-glass inputs when %s, because an App is no admin',
    async (_why, actor) => {
      if (!actor.endsWith('[bot]')) {
        permission(actor, 'write')
      }

      await expect(
        check({
          scope: 'apply',
          actor,
          env: { AIP_BREAK_GLASS_INPUTS: 'true' }
        })
      ).rejects.toMatchObject({ outcome: 'not-admin' })
    }
  )

  test('lets admins use break-glass inputs, both of them', async () => {
    permission('admin-a', 'admin')
    permission('admin-b', 'admin')

    await expect(
      check({
        scope: 'apply',
        actor: 'admin-a',
        triggering: 'admin-b',
        env: { AIP_BREAK_GLASS_INPUTS: 'true' }
      })
    ).resolves.toMatchObject({ outcome: 'admin' })
  })

  test('lets only admins run pause.yml, an exempt App included', async () => {
    await expect(check({ scope: 'pause', actor: APP })).rejects.toMatchObject({
      outcome: 'not-admin'
    })

    permission('admin-a', 'admin')
    await expect(
      check({ scope: 'pause', actor: 'admin-a' })
    ).resolves.toMatchObject({ outcome: 'admin' })
  })

  describe('reconcile-all', () => {
    const ALL = { AIP_ALL: 'true' }

    test("lets an engineer's run from main of the caller through, with no admin role", async () => {
      await expect(
        check({ scope: 'apply', actor: 'writer', env: ALL })
      ).resolves.toMatchObject({ outcome: 'reconcile-all' })
    })

    test.each([
      [
        'another caller',
        {
          AIP_WORKFLOW_REF: `${OWNER}/ai-platform-tenants/.github/workflows/apply.yml@refs/heads/main`
        }
      ],
      [
        'a branch of the caller',
        {
          AIP_WORKFLOW_REF: `${OWNER}/ai-platform-tenants/.github/workflows/reconcile-all.yml@refs/heads/feature`
        }
      ],
      [
        "another repository's caller",
        {
          AIP_WORKFLOW_REF: `${OWNER}/ai-platform-deployments/.github/workflows/reconcile-all.yml@refs/heads/main`
        }
      ],
      ['a caller that is not all', { AIP_ALL: 'false' }],
      [
        'one that also sets break-glass inputs',
        { AIP_BREAK_GLASS_INPUTS: 'true' }
      ],
      ['one that has no all', { AIP_ALL: '' }]
    ])('is refused for %s', async (_why, env) => {
      permission('writer', 'write')

      await expect(
        check({ scope: 'apply', actor: 'writer', env: { ...ALL, ...env } })
      ).rejects.toMatchObject({ outcome: 'not-admin' })
    })

    test('is not an exemption for a submit', async () => {
      permission('writer', 'write')

      await expect(
        check({ scope: 'submit', actor: 'writer', env: ALL })
      ).rejects.toMatchObject({ outcome: 'not-admin' })
    })
  })

  test('refuses an unknown scope before anything else', async () => {
    await expect(check({ scope: 'deploy', actor: APP })).rejects.toMatchObject({
      outcome: 'failed'
    })
  })

  test.each(['Infradev', 'a', '../x', 'infradev-events'])(
    'refuses the environment %s before any job can make GitHub create it, an exempt App included',
    async (environment) => {
      await expect(
        check({ actor: APP, env: { AIP_ENVIRONMENT: environment } })
      ).rejects.toMatchObject({
        outcome: 'checks-failed',
        message: `invalid environment ${environment}`
      })
    }
  )

  test('accepts a valid environment, or none for a run that names none', async () => {
    await expect(
      check({ actor: APP, env: { AIP_ENVIRONMENT: 'infradev' } })
    ).resolves.toMatchObject({ outcome: 'exempt-app' })
    await expect(
      check({ actor: APP, env: { AIP_ENVIRONMENT: '' } })
    ).resolves.toMatchObject({ outcome: 'exempt-app' })
  })

  test('records who was allowed and why in the job summary', async () => {
    await check({ actor: APP })

    expect(jobSummary()).toContain('exempt-app')
    expect(jobSummary()).toContain(APP)
  })
})
