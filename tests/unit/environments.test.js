import nock from 'nock'

import {
  dispatchChangedEnvironments,
  latestRelease
} from '../../src/environments.js'
import {
  comparison,
  dispatchedRun,
  fileContent,
  gitRef,
  release
} from '../fixtures/github-api.js'
import { pin, registry, registryEntry } from '../fixtures/gitops-documents.js'
import {
  API,
  commandInput,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA
} from '../helpers/github.js'

const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`
const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const BEFORE = 'e'.repeat(40)
const TWO_ENVIRONMENTS = registry([
  registryEntry(),
  registryEntry({ name: 'sandbox' })
])

describe('latestRelease', () => {
  test('exports the newest infra release and its commit', async () => {
    nock(API).get(`${INFRA}/releases/latest`).reply(200, release('v0.4.0'))
    nock(API)
      .get(`${INFRA}/git/ref/tags%2Fv0.4.0`)
      .reply(200, gitRef('c'.repeat(40)))

    await expect(
      latestRelease(commandInput({}, { repo: 'ai-platform-environments' }))
    ).resolves.toEqual({ release: 'v0.4.0', sha: 'c'.repeat(40) })
    expect(exportedVariables()).toEqual({
      AIP_RELEASE: 'v0.4.0',
      AIP_SHA: 'c'.repeat(40)
    })
  })
})

describe('dispatchChangedEnvironments', () => {
  function input(before = BEFORE) {
    return commandInput(
      {},
      {
        repo: 'ai-platform-environments',
        eventName: 'push',
        payload: { before, after: SHA }
      }
    )
  }

  function registryAtHead() {
    nock(API)
      .get(`${ENVIRONMENTS}/contents/registry.json`)
      .query({ ref: SHA })
      .reply(200, fileContent(TWO_ENVIRONMENTS))
  }

  function changed(files) {
    nock(API)
      .get(`${ENVIRONMENTS}/compare/${BEFORE}...${SHA}`)
      .query(true)
      .reply(200, comparison({ files }))
  }

  function pinned(environment, present = true) {
    nock(API)
      .get(
        `${DEPLOYMENTS}/contents/environments%2F${environment}%2Fplatform.json`
      )
      .query({ ref: 'main' })
      .reply(present ? 200 : 404, present ? fileContent(pin()) : undefined)
  }

  function applyDispatched(environment, runId) {
    return nock(API)
      .post(
        `${DEPLOYMENTS}/actions/workflows/apply.yml/dispatches`,
        (body) =>
          body.ref === 'main' &&
          body.inputs.environment === environment &&
          body.inputs.reason === `parameters changed in ${SHA.slice(0, 7)}`
      )
      .reply(200, dispatchedRun(runId, 'ai-platform-deployments'))
  }

  test('dispatches the platform apply of an environment whose parameters changed', async () => {
    registryAtHead()
    changed(['environments/infradev/platform.tfvars.json'])
    pinned('infradev')
    const started = applyDispatched('infradev', 31)

    await expect(dispatchChangedEnvironments(input())).resolves.toEqual({
      dispatched: ['infradev']
    })
    expect(started.isDone()).toBe(true)
    expect(jobSummary()).toContain('actions/runs/31')
  })

  test('dispatches every environment when a shared file changed', async () => {
    registryAtHead()
    changed(['global.tfvars.json'])
    pinned('infradev')
    pinned('sandbox')
    applyDispatched('infradev', 31)
    applyDispatched('sandbox', 32)

    await expect(dispatchChangedEnvironments(input())).resolves.toEqual({
      dispatched: ['infradev', 'sandbox']
    })
  })

  test('treats the first push as a change to everything', async () => {
    registryAtHead()
    pinned('infradev')
    pinned('sandbox', false)
    applyDispatched('infradev', 31)

    await expect(
      dispatchChangedEnvironments(input('0'.repeat(40)))
    ).resolves.toEqual({ dispatched: ['infradev'] })
    expect(jobSummary()).toContain('`sandbox`: no pin yet')
  })

  test('dispatches nothing when no environment changed', async () => {
    registryAtHead()
    changed(['README.md'])

    await expect(dispatchChangedEnvironments(input())).resolves.toEqual({
      dispatched: []
    })
    expect(jobSummary()).toContain('No environment changed.')
  })
})
