import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createWorkspace } from '../../helpers/scripts.js'

const QUEUE =
  'https://sqs.eu-west-2.amazonaws.com/000000000000/aip-gitops-events.fifo'
const ROLE = 'arn:aws:iam::000000000000:role/aip-events'
const AUDIENCE = 'api://aip-events'

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
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    AIP_PUBLISH_SECONDS: '300',
    ...env
  })
}

function calls(prefix) {
  return workspace.commands().filter((line) => line.startsWith(prefix))
}

describe('publish-event.sh', () => {
  test('signs in as the events identity, assumes the role and sends each event to its group', () => {
    workspace.write('events.json', events('op-00000001', 'op-00000002'))

    const result = publish()

    expect(result.status).toBe(0)
    expect(calls('az')).toEqual([
      `az account get-access-token --resource ${AUDIENCE} --query accessToken --output tsv`
    ])
    expect(calls('aws sts')).toEqual([
      expect.stringContaining(
        `--role-arn ${ROLE} --role-session-name aip-events-123-2 --web-identity-token file://`
      )
    ])
    expect(calls('aws sqs')).toEqual([
      expect.stringContaining(
        `aws sqs send-message --region eu-west-2 --queue-url ${QUEUE} --message-body {"eventId":"op-00000001:deployed:123:1","status":"deployed"} --message-group-id op-00000001 --message-deduplication-id op-00000001:deployed:123:1`
      ),
      expect.stringContaining('--message-group-id op-00000002')
    ])
    expect(result.stdout).toContain('Sent 2 of 2 events.')
  })

  test('passes the token in a file, never on a command line, and masks it', () => {
    workspace.write('events.json', events('op-00000001'))

    const result = publish()

    expect(workspace.commands().join('\n')).not.toMatch(
      /--web-identity-token fake-entra-token/
    )
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
    expect(existsSync(join(workspace.dir, 'aip-events-token'))).toBe(false)
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
    ['AIP_EVENTS_AUDIENCE']
  ])('sends nothing, and says so, where %s is not set', (name) => {
    workspace.write('events.json', events('op-00000001'))

    const result = publish({ [name]: '' })

    expect(result.status).toBe(0)
    expect(workspace.commands()).toEqual([])
    expect(result.stdout).toContain('::notice::AIP_EVENTS_QUEUE_URL')
  })

  describe('when the queue or the identity is unreachable, the run still passes', () => {
    test('warns and gives up when no token comes', () => {
      workspace.write('events.json', events('op-00000001'))

      const result = publish({ AIP_TEST_FAIL: 'get-access-token' })

      expect(result.status).toBe(0)
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

    test('retries a send twice, then warns, and still tries the next event', () => {
      workspace.write('events.json', events('op-00000001', 'op-00000002'))

      const result = publish({ AIP_TEST_FAIL: 'group-id op-00000001' })

      expect(result.status).toBe(0)
      expect(
        calls('aws sqs').filter((line) =>
          line.includes('--message-group-id op-00000001')
        )
      ).toHaveLength(3)
      expect(result.stdout).toContain(
        '::warning::publish-event: could not send op-00000001:deployed:123:1'
      )
      expect(result.stdout).toContain('Sent 1 of 2 events.')
    })

    test('gives up within its time budget when the queue hangs', () => {
      workspace.write('events.json', events('op-00000001'))
      const started = Date.now()

      const result = publish({
        AIP_TEST_SLEEP: '30',
        AIP_PUBLISH_SECONDS: '2'
      })

      expect(result.status).toBe(0)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(result.stdout).toContain('::warning::publish-event:')
    })
  })
})
