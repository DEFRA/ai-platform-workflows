import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

const QUEUE =
  'https://sqs.eu-west-2.amazonaws.com/000000000000/aip_gitops_events.fifo'
const ROLE = 'arn:aws:iam::000000000000:role/aip-events'
const AUDIENCE = 'api://aip-events'
const CLIENT = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'

let workspace

beforeEach(() => {
  workspace = createWorkspace()
})

afterEach(() => workspace.cleanup())

function events(...ids) {
  return JSON.stringify(
    ids.map((id) => ({
      groupId: id,
      deduplicationId: `${id}:deployed:123:1`,
      body: { eventId: `${id}:deployed:123:1`, status: 'deployed' }
    }))
  )
}

function publish(env = {}) {
  return workspace.run('publish-event.sh', [], {
    AIP_EVENT_FILE: workspace.path('events.json'),
    AIP_EVENTS_QUEUE_URL: QUEUE,
    AIP_EVENTS_ROLE_ARN: ROLE,
    AIP_EVENTS_AUDIENCE: AUDIENCE,
    AIP_EVENTS_CLIENT_ID: CLIENT,
    AZURE_TENANT_ID: TENANT,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/oidc?api-version=2',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    AIP_EVENT_DEADLINE: inSeconds(300),
    ...env
  })
}

function inSeconds(seconds) {
  return String(Math.ceil(Date.now() / 1000) + seconds)
}

function calls(prefix) {
  return workspace.commands().filter((line) => line.startsWith(prefix))
}

function batches() {
  return calls('entries ').map((line) => JSON.parse(line.slice(8)))
}

describe('publish-event.sh', () => {
  test('exchanges the job token for the events identity, assumes the role and sends the events in one batch', () => {
    workspace.write('events.json', events('op-00000001', 'op-00000002'))

    const result = publish()

    expect(result.status).toBe(0)
    expect(calls('curl ')).toEqual([
      'curl https://token.example/oidc?api-version=2&audience=api://AzureADTokenExchange',
      `curl https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`
    ])
    expect(calls('form')).toEqual([
      `form client_id=${CLIENT}`,
      'form grant_type=client_credentials',
      'form client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      'form-file client_assertion fake-oidc',
      `form scope=${AUDIENCE}/.default`
    ])
    expect(calls('az')).toEqual([])
    expect(result.stdout).toContain('::add-mask::fake-oidc')
    expect(calls('aws sts')).toEqual([
      expect.stringContaining(
        `--role-arn ${ROLE} --role-session-name aip-events-123-2 --web-identity-token file://`
      )
    ])
    expect(calls('aws sqs')).toEqual([
      expect.stringContaining(
        `aws sqs send-message-batch --region eu-west-2 --queue-url ${QUEUE} --entries file://`
      )
    ])
    expect(calls('aws sqs')[0]).not.toContain('MessageBody')
    expect(batches()).toEqual([
      [
        {
          Id: 'e0',
          MessageBody:
            '{"eventId":"op-00000001:deployed:123:1","status":"deployed"}',
          MessageGroupId: 'op-00000001',
          MessageDeduplicationId: 'op-00000001:deployed:123:1'
        },
        {
          Id: 'e1',
          MessageBody:
            '{"eventId":"op-00000002:deployed:123:1","status":"deployed"}',
          MessageGroupId: 'op-00000002',
          MessageDeduplicationId: 'op-00000002:deployed:123:1'
        }
      ]
    ])
    expect(result.stdout).toContain('Sent 2 of 2 events.')
  })

  test('sends at most 10 events a call', () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `op-${String(index + 1).padStart(8, '0')}`
    )
    workspace.write('events.json', events(...ids))

    const result = publish()

    expect(batches().map((batch) => batch.length)).toEqual([10, 2])
    expect(batches()[1].map(({ Id }) => Id)).toEqual(['e10', 'e11'])
    expect(result.stdout).toContain('Sent 12 of 12 events.')
  })

  test('leaves transient failures to curl and the AWS CLI, two retries each', () => {
    workspace.write('events.json', events('op-00000001'))

    publish()

    expect(calls('curl-retry')).toEqual(['curl-retry 2', 'curl-retry 2'])
    expect(calls('aws-retry')).toEqual([
      'aws-retry standard 3',
      'aws-retry standard 3'
    ])
  })

  test('says on the run summary page how many events were sent', () => {
    workspace.write('events.json', events('op-00000001', 'op-00000002'))

    publish()

    expect(workspace.summary()).toBe(
      '- Status events: sent 2 of 2 to the events queue\n'
    )
  })

  test('names on the run summary page every event that was not sent', () => {
    workspace.write('events.json', events('op-00000001', 'op-00000002'))

    publish({ AIP_TEST_REFUSE_GROUP: 'op-00000001' })

    expect(workspace.summary()).toBe(
      '- Status events: could not send op-00000001:deployed:123:1 (InvalidParameterValue: Invalid binary character); the events stay in the run report\n' +
        '- Status events: sent 1 of 2 to the events queue\n'
    )
  })

  test('passes the tokens in files, never on a command line, and masks them', () => {
    workspace.write('events.json', events('op-00000001'))

    const result = publish()

    expect(
      [...calls('curl '), ...calls('form '), ...calls('aws ')].join('\n')
    ).not.toMatch(/fake-oidc|fake-entra-token/)
    expect(calls('form-file')).toEqual(['form-file client_assertion fake-oidc'])
    expect(calls('token-file')).toEqual(['token-file fake-entra-token'])
    expect(result.stdout).toContain('::add-mask::fake-entra-token')
    expect(result.stdout).toContain('::add-mask::fake-secret')
    expect(result.stdout).toContain('::add-mask::fake-session')
  })

  test('sends with the credentials the role gave, and only for the send', () => {
    workspace.write('events.json', events('op-00000001'))

    publish()

    expect(calls('credentials')).toEqual([
      'credentials AKIAFAKE fake-secret fake-session'
    ])
  })

  test('leaves no token file behind', () => {
    workspace.write('events.json', events('op-00000001'))

    publish()

    expect(calls('token-file')).toHaveLength(1)
    expect(existsSync(join(workspace.dir, 'aip-events'))).toBe(false)
  })

  test('does nothing without events', () => {
    const missing = publish({ AIP_EVENT_FILE: '' })
    workspace.write('events.json', '')
    const empty = publish()

    expect(missing.status).toBe(0)
    expect(empty.status).toBe(0)
    expect(workspace.commands()).toEqual([])
    expect(empty.stdout).toContain('No events to send.')
  })

  test.each([
    ['AIP_EVENTS_QUEUE_URL'],
    ['AIP_EVENTS_ROLE_ARN'],
    ['AIP_EVENTS_AUDIENCE'],
    ['AIP_EVENTS_CLIENT_ID'],
    ['AZURE_TENANT_ID'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
    ['AIP_EVENT_DEADLINE']
  ])('sends nothing, and says so, where %s is not set', (name) => {
    workspace.write('events.json', events('op-00000001'))

    const result = publish({ [name]: '' })

    expect(result.status).toBe(0)
    expect(workspace.commands()).toEqual([])
    expect(result.stdout).toContain('::notice::AIP_EVENTS_QUEUE_URL')
  })

  describe('when the queue or the identity is unreachable, the run still passes', () => {
    test("warns with Entra's reason, and gives up, when the token exchange is refused", () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_FAIL: 'token-exchange' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        '::warning::publish-event: could not get a token for the events audience (AADSTS700213); the events stay in the run report'
      )
      expect(calls('aws')).toEqual([])
    })

    test('warns without a reason when Entra answers with no token and no JSON', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_FAIL: 'token-exchange-html' })

      expect(result.stdout).toContain(
        '::warning::publish-event: could not get a token for the events audience; the events stay in the run report'
      )
      expect(calls('aws')).toEqual([])
    })

    test('warns and gives up when the role is refused (a subject that is not federated)', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_FAIL: 'assume-role-with-web-identity' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('could not assume the events role')
      expect(calls('aws sqs')).toEqual([])
    })

    test('says which issuer, audience, subject and version the refused token had, and nothing else from it', () => {
      workspace.write('events.json', events('op-00000001'))
      const part = (value) =>
        Buffer.from(JSON.stringify(value)).toString('base64url')
      const token = `${part({ alg: 'RS256' })}.${part({
        iss: 'https://login.microsoftonline.com/tenant/v2.0',
        aud: 'audience-guid',
        sub: 'subject-guid',
        ver: '2.0',
        appid: 'not-reported'
      })}.signature-not-reported`

      const result = publish({
        AIP_TEST_TOKEN: token,
        AIP_TEST_FAIL: 'assume-role-with-web-identity'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        '::notice::publish-event: the token the role refused had iss=https://login.microsoftonline.com/tenant/v2.0 aud=audience-guid sub=subject- ver=2.0'
      )
      const shown = result.stdout
        .split('\n')
        .filter((line) => !line.startsWith('::add-mask::'))
        .join('\n')

      expect(shown).not.toContain('not-reported')
    })

    test('lets no claim write a workflow command or show the whole subject', () => {
      workspace.write('events.json', events('op-00000001'))
      const part = (value) =>
        Buffer.from(JSON.stringify(value)).toString('base64url')
      const token = `${part({ alg: 'RS256' })}.${part({
        iss: 'issuer',
        aud: 'audience\n::error::injected',
        sub: 'subject-guid-with-the-rest',
        ver: '2.0'
      })}.signature`

      const result = publish({
        AIP_TEST_TOKEN: token,
        AIP_TEST_FAIL: 'assume-role-with-web-identity'
      })
      const shown = result.stdout
        .split('\n')
        .filter((line) => !line.startsWith('::add-mask::'))

      expect(shown).toContain(
        '::notice::publish-event: the token the role refused had iss=issuer aud=audience::error::injected sub=subject- ver=2.0'
      )
      expect(shown.join('\n')).not.toContain('with-the-rest')
    })

    test.each([
      ['an opaque string', undefined],
      ['base64 JSON with no dots', 'e30'],
      ['two parts only', 'e30.e30'],
      ['four parts', 'e30.e30.e30.e30']
    ])(
      'reports no claims when the refused token is not a JWT (%s)',
      (_what, token) => {
        workspace.write('events.json', events('op-00000001'))

        const result = publish({
          AIP_TEST_FAIL: 'assume-role-with-web-identity',
          ...(token && { AIP_TEST_TOKEN: token })
        })

        expect(result.stdout).toContain('could not assume the events role')
        expect(result.stdout).not.toContain('the token the role refused had')
      }
    )

    test('sends again only the events SQS failed on its side, twice, then warns', () => {
      workspace.write('events.json', events('op-00000001', 'op-00000002'))

      const result = publish({ AIP_TEST_RETRY_GROUP: 'op-00000001' })

      expect(result.status).toBe(0)
      expect(
        batches().map((batch) =>
          batch.map(({ MessageGroupId }) => MessageGroupId)
        )
      ).toEqual([
        ['op-00000001', 'op-00000002'],
        ['op-00000001'],
        ['op-00000001']
      ])
      expect(result.stdout).toContain(
        '::warning::publish-event: could not send op-00000001:deployed:123:1 (ServiceUnavailable); the events stay in the run report'
      )
      expect(result.stdout).toContain('Sent 1 of 2 events.')
    })

    test("does not send again an event SQS refused as the sender's fault", () => {
      workspace.write('events.json', events('op-00000001', 'op-00000002'))

      const result = publish({ AIP_TEST_REFUSE_GROUP: 'op-00000001' })

      expect(batches()).toHaveLength(1)
      expect(result.stdout).toContain(
        '::warning::publish-event: could not send op-00000001:deployed:123:1 (InvalidParameterValue: Invalid binary character); the events stay in the run report'
      )
      expect(result.stdout).toContain('Sent 1 of 2 events.')
    })

    test("keeps SQS's reason to one line, so it cannot write a workflow command", () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({
        AIP_TEST_REFUSE_GROUP: 'op-00000001',
        AIP_TEST_REFUSE_MESSAGE: 'bad\n::error::injected'
      })

      expect(result.stdout).toContain(
        'could not send op-00000001:deployed:123:1 (InvalidParameterValue: bad ::error::injected)'
      )
      expect(result.stdout.split('\n')).not.toContain('::error::injected')
    })

    test('warns for every event of a batch the AWS CLI could not send at all, without trying it again', () => {
      workspace.write('events.json', events('op-00000001', 'op-00000002'))

      const result = publish({ AIP_TEST_FAIL: 'send-message-batch' })

      expect(result.status).toBe(0)
      expect(calls('aws sqs')).toHaveLength(1)
      expect(result.stdout).toContain(
        'could not send op-00000001:deployed:123:1 (the batch call failed)'
      )
      expect(result.stdout).toContain(
        'could not send op-00000002:deployed:123:1 (the batch call failed)'
      )
      expect(result.stdout).toContain('Sent 0 of 2 events.')
    })

    test('does not retry a refused role, which no retry can change', () => {
      workspace.write('events.json', events('op-00000001'))

      publish({ AIP_TEST_FAIL: 'assume-role-with-web-identity' })

      expect(calls('aws sts')).toHaveLength(1)
    })

    test('gives up within its time budget when the queue hangs', () => {
      workspace.write('events.json', events('op-00000001'))
      const started = Date.now()

      const result = publish({
        AIP_TEST_SLEEP: '30',
        AIP_EVENT_DEADLINE: inSeconds(2)
      })

      expect(result.status).toBe(0)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(result.stdout).toContain('::warning::publish-event:')
    })

    test('shares the deadline build-event left: nothing is sent when the lookups used all the time', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({
        AIP_EVENT_DEADLINE: inSeconds(-5)
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        '::warning::publish-event: the time for reporting ran out before the events were built'
      )
      expect(workspace.commands()).toEqual([])
    })

    test('gives up within its time budget when the sign-in hangs, before any other call', () => {
      workspace.write('events.json', events('op-00000001'))
      const started = Date.now()

      const result = publish({
        AIP_TEST_SLEEP_CURL: '30',
        AIP_EVENT_DEADLINE: inSeconds(2)
      })

      expect(result.status).toBe(0)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(result.stdout).toContain(
        "::warning::publish-event: could not get the job's identity token"
      )
      // A slow shell may use the 2 seconds before curl starts at all.
      expect(calls('curl ').length).toBeLessThanOrEqual(1)
      expect(calls('aws')).toEqual([])
    })

    test('warns and gives up when the identity token cannot be had', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_FAIL: 'curl' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain("could not get the job's identity token")
      expect(calls('curl ')).toHaveLength(1)
    })

    test('warns and gives up when the job identity token comes back empty', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_CURL_BODY: '{}' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain("the job's identity token was empty")
      expect(calls('curl ')).toHaveLength(1)
    })
  })
})
