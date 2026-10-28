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
      AIP_APPROVERS: 'engineer-1'
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
      AIP_APPROVERS: ''
    })
  })

  test.each([
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
    ],
    [[pullRequestFile('environments/README.md')], 0],
    [[pullRequestFile('README.md'), pullRequestFile('environments/x.json')], 0]
  ])('refuses a pull request that changes %j', async (files, count) => {
    changedFiles(TENANTS, files)

    await expect(prepareValidation(input())).rejects.toMatchObject({
      outcome: 'checks-failed',
      message: expect.stringContaining(`this one changes ${count}`)
    })
  })

  describe('a pull request that changes nothing under environments/', () => {
    const files = [
      pullRequestFile('.github/CODEOWNERS'),
      pullRequestFile('README.md')
    ]

    test('passes once someone has approved its head, and skips the file checks', async () => {
      changedFiles(TENANTS, files)
      reviews(TENANTS, [
        review('admin-1', 'APPROVED', HEAD),
        review('admin-2', 'COMMENTED', HEAD)
      ])

      await expect(prepareValidation(input())).resolves.toEqual({
        environment: null,
        release: null,
        outcome: 'approved'
      })
      expect(exportedVariables()).toEqual({ AIP_SKIP_VALIDATION: 'true' })
      expect(jobSummary()).toContain('### approved')
      expect(jobSummary()).toContain('admin-1')
    })

    test('keeps an approval that a later comment-only review did not withdraw', async () => {
      changedFiles(TENANTS, files)
      reviews(TENANTS, [
        review('admin-1', 'APPROVED', HEAD),
        review('admin-1', 'COMMENTED', HEAD)
      ])

      await expect(prepareValidation(input())).resolves.toMatchObject({
        outcome: 'approved'
      })
      expect(jobSummary()).toContain('admin-1')
    })

    test.each([
      ['has no review', []],
      ['only has a comment', [review('a', 'COMMENTED', HEAD)]],
      [
        'was approved only before its head moved',
        [review('a', 'APPROVED', 'old')]
      ],
      [
        'had its approval withdrawn',
        [review('a', 'APPROVED', HEAD), review('a', 'CHANGES_REQUESTED', HEAD)]
      ],
      [
        'had its approval dismissed',
        [review('a', 'APPROVED', HEAD), review('a', 'DISMISSED', HEAD)]
      ]
    ])('fails closed when it %s', async (_why, list) => {
      changedFiles(TENANTS, files)
      reviews(TENANTS, list)

      await expect(prepareValidation(input())).rejects.toMatchObject({
        outcome: 'checks-failed',
        message:
          'A pull request that changes nothing under environments/ needs an approving review of its head commit.'
      })
      expect(exportedVariables()).toEqual({})
    })

    test('is still validated when it also changes an environment', async () => {
      changedFiles(TENANTS, [
        ...files,
        pullRequestFile('environments/infradev/alpha.json')
      ])
      nock(API)
        .get(`${DEPLOYMENTS}/contents/${PIN}`)
        .query({ ref: 'main' })
        .reply(200, fileContent(pin()))
      tagResolves()
      reviews(TENANTS, [])
      environmentsRepo()

      await expect(prepareValidation(input())).resolves.toEqual({
        environment: 'infradev',
        release: 'v0.4.0'
      })
      expect(exportedVariables()).not.toHaveProperty('AIP_SKIP_VALIDATION')
    })
  })
})
