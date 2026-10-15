import nock from 'nock'

import {
  environmentName,
  kindOf,
  OutcomeError,
  pinnedRelease
} from '../../src/gitops.js'
import { fileContent, gitRef } from '../fixtures/github-api.js'
import { INFRA_SHA, pin } from '../fixtures/gitops-documents.js'
import { API, createContext, createOctokit, OWNER } from '../helpers/github.js'

const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const PIN = 'environments%2Finfradev%2Fplatform.json'

function tagResolves(sha = INFRA_SHA) {
  nock(API).get(`${INFRA}/git/ref/tags%2Fv0.4.0`).reply(200, gitRef(sha))
}

describe('environmentName', () => {
  test('accepts a registry entry name', () => {
    expect(environmentName('infradev')).toBe('infradev')
  })

  test.each(['Infradev', '../x', '', undefined])(
    'refuses %s as checks-failed',
    (value) => {
      expect(() => environmentName(value)).toThrow(OutcomeError)
      expect(() => environmentName(value)).toThrow('invalid environment')
    }
  )
})

describe('kindOf', () => {
  test.each([
    ['ai-platform-tenants', 'tenants'],
    ['ai-platform-deployments', 'pins']
  ])('knows %s holds %s', (repo, kind) => {
    expect(kindOf(repo)).toBe(kind)
  })

  test('refuses any other repository', () => {
    expect(() => kindOf('ai-platform-infra')).toThrow(
      'this runs only in ai-platform-tenants or ai-platform-deployments'
    )
  })
})

describe('pinnedRelease', () => {
  test('reads a tenants change at the pin on main of the deployments repository', async () => {
    nock(API)
      .get(`${DEPLOYMENTS}/contents/${PIN}`)
      .query({ ref: 'main' })
      .reply(200, fileContent(pin()))
    tagResolves()

    await expect(
      pinnedRelease({
        github: createOctokit(),
        app: createOctokit('app'),
        context: createContext(),
        kind: 'tenants',
        environment: 'infradev'
      })
    ).resolves.toEqual({ release: 'v0.4.0', sha: INFRA_SHA })
  })

  test('reads a pin change at the pin it replaces', async () => {
    nock(API)
      .get(`${DEPLOYMENTS}/contents/${PIN}`)
      .query({ ref: 'base-sha' })
      .reply(200, fileContent(pin()))
    tagResolves()

    await expect(
      pinnedRelease({
        github: createOctokit(),
        app: createOctokit('app'),
        context: createContext({ repo: 'ai-platform-deployments' }),
        kind: 'pins',
        environment: 'infradev',
        ref: 'base-sha',
        fallback: pin({ release: 'v0.5.0' })
      })
    ).resolves.toEqual({ release: 'v0.4.0', sha: INFRA_SHA })
  })

  test("reads an environment's first pin at its own release", async () => {
    nock(API).get(`${DEPLOYMENTS}/contents/${PIN}`).query(true).reply(404)
    tagResolves()

    await expect(
      pinnedRelease({
        github: createOctokit(),
        app: createOctokit('app'),
        context: createContext({ repo: 'ai-platform-deployments' }),
        kind: 'pins',
        environment: 'infradev',
        ref: 'base-sha',
        fallback: pin()
      })
    ).resolves.toEqual({ release: 'v0.4.0', sha: INFRA_SHA })
  })

  test('refuses an environment with no pin yet', async () => {
    nock(API).get(`${DEPLOYMENTS}/contents/${PIN}`).query(true).reply(404)

    await expect(
      pinnedRelease({
        github: createOctokit(),
        app: createOctokit('app'),
        context: createContext(),
        kind: 'tenants',
        environment: 'infradev'
      })
    ).rejects.toMatchObject({
      outcome: 'checks-failed',
      message: 'infradev has no platform pin yet'
    })
  })
})
