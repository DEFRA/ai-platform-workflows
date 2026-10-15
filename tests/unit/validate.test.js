import nock from 'nock'

import { prepareValidation } from '../../src/validate.js'
import {
  fileContent,
  gitRef,
  pullRequest,
  pullRequestFile,
  review
} from '../fixtures/github-api.js'
import { INFRA_SHA, pin } from '../fixtures/gitops-documents.js'
import {
  API,
  commandInput,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA
} from '../helpers/github.js'

const TENANTS = `/repos/${OWNER}/ai-platform-tenants`
const DEPLOYMENTS = `/repos/${OWNER}/ai-platform-deployments`
const ENVIRONMENTS = `/repos/${OWNER}/ai-platform-environments`
const INFRA = `/repos/${OWNER}/ai-platform-infra`
const PIN = 'environments%2Finfradev%2Fplatform.json'
const HEAD = 'b'.repeat(40)

function input(pull = pullRequest(), repo = 'ai-platform-tenants') {
  return commandInput(
    { env: { AIP_CONFIG: `${process.env.RUNNER_TEMP}/config` } },
    { repo, eventName: 'pull_request', payload: { pull_request: pull } }
  )
}

function changedFiles(repo, files) {
  nock(API)
    .get(`${repo}/pulls/7/files`)
    .query({ per_page: '100' })
    .reply(200, files)
}

function reviews(repo, list) {
  nock(API)
    .get(`${repo}/pulls/7/reviews`)
    .query({ per_page: '100' })
    .reply(200, list)
}

function environmentsRepo() {
  for (const path of [
    'registry.json',
    'global.tfvars.json',
    'environments%2Finfradev%2Fplatform.tfvars.json'
  ]) {
    nock(API)
      .get(`${ENVIRONMENTS}/contents/${path}`)
      .query({ ref: 'main' })
      .reply(200, fileContent('{}\n'))
  }
}

function tagResolves() {
  nock(API).get(`${INFRA}/git/ref/tags%2Fv0.4.0`).reply(200, gitRef(INFRA_SHA))
}

describe('prepareValidation', () => {
  test('exports what the checks need for a team file change', async () => {
    changedFiles(TENANTS, [pullRequestFile('environments/infradev/alpha.json')])
    nock(API)
      .get(`${DEPLOYMENTS}/contents/${PIN}`)
      .query({ ref: 'main' })
      .reply(200, fileContent(pin()))
    tagResolves()
    reviews(TENANTS, [
      review('engineer-1', 'APPROVED', HEAD),
      review('engineer-2', 'APPROVED', HEAD),
      review('engineer-2', 'CHANGES_REQUESTED', HEAD),
      review('engineer-3', 'APPROVED', 'old-commit')
    ])
    environmentsRepo()

    await expect(prepareValidation(input())).resolves.toEqual({
      environment: 'infradev',
      release: 'v0.4.0'
    })
    expect(exportedVariables()).toEqual({
      AIP_KIND: 'tenants',
      AIP_ENVIRONMENT: 'infradev',
      AIP_RELEASE: 'v0.4.0',
      AIP_SHA: INFRA_SHA,
      AIP_BASE_SHA: SHA,
      AIP_HEAD_SHA: HEAD,
      AIP_AUTHOR: 'ai-platform-orchestrator[bot]',
      AIP_LABELS: 'gitops,env:infradev',
      AIP_APPROVERS: 'engineer-1',
      AIP_OPERATION_ID: '000000000000000000000001'
    })
    expect(jobSummary()).toContain('### infradev at v0.4.0')
  })

  test('validates a pin change at the release the environment runs now', async () => {
    changedFiles(DEPLOYMENTS, [
      pullRequestFile('environments/infradev/platform.json')
    ])
    nock(API)
      .get(`${DEPLOYMENTS}/contents/${PIN}`)
      .query({ ref: HEAD })
      .reply(200, fileContent(pin({ release: 'v0.5.0' })))
    nock(API)
      .get(`${DEPLOYMENTS}/contents/${PIN}`)
      .query({ ref: SHA })
      .reply(200, fileContent(pin()))
    tagResolves()
    reviews(DEPLOYMENTS, [])
    environmentsRepo()

    await expect(
      prepareValidation(
        input(
          pullRequest({ head: { ref: 'engineer/pin', sha: HEAD } }),
          'ai-platform-deployments'
        )
      )
    ).resolves.toEqual({ environment: 'infradev', release: 'v0.4.0' })
    expect(exportedVariables()).toMatchObject({
      AIP_KIND: 'pins',
      AIP_OPERATION_ID: ''
    })
  })

  test.each([
    [[pullRequestFile('README.md')], 0],
    [
      [
        pullRequestFile('environments/infradev/alpha.json'),
        pullRequestFile('environments/sandbox/alpha.json')
      ],
      2
    ],
    [
      [
        pullRequestFile(
          'environments/sandbox/alpha.json',
          'environments/infradev/alpha.json'
        )
      ],
      2
    ]
  ])('refuses a pull request that changes %j', async (files, count) => {
    changedFiles(TENANTS, files)

    await expect(prepareValidation(input())).rejects.toMatchObject({
      outcome: 'checks-failed',
      message: expect.stringContaining(`this one changes ${count}`)
    })
  })
})
