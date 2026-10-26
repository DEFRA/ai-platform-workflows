/* eslint-disable no-template-curly-in-string -- these tests match GitHub Actions expressions in the workflow files */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOWS = join(ROOT, '.github/workflows')
const ACTIONS = join(ROOT, '.github/actions')

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

// The text of one top-level job, up to the next job.
function job(file, name) {
  const text = read(`.github/workflows/${file}`)
  const start = text.search(new RegExp(`^ {2}${name}:\\n`, 'm'))
  const rest = text.slice(start + 1)
  const end = rest.search(/^ {2}[a-z][a-z-]*:\n/m)

  return end === -1 ? rest : rest.slice(0, end)
}

function everyFile() {
  const files = readdirSync(WORKFLOWS).map(
    (file) => `.github/workflows/${file}`
  )

  for (const action of readdirSync(ACTIONS)) {
    files.push(`.github/actions/${action}/action.yml`)
  }

  return files
}

describe('every workflow and action', () => {
  test.each(everyFile())('%s calls this repository only at v2', (file) => {
    expect(read(file)).not.toMatch(/ai-platform-workflows\/[^\s]+@v1\b/)
  })

  test.each(everyFile())(
    '%s never puts an expression in a run script (injection)',
    (file) => {
      const lines = read(file).split('\n')
      const scripts = lines.filter((line, index) => {
        const inBlock = /^\s+run: [|>]/.test(lines[index - 1] ?? '')

        return /^\s+(- )?run: /.test(line) || inBlock
      })

      expect(scripts.filter((line) => line.includes('${{'))).toEqual([])
    }
  )

  test('the actions a workflow here calls exist', () => {
    const wanted = new Set()

    for (const file of everyFile()) {
      for (const [, name] of read(file).matchAll(
        /ai-platform-workflows\/\.github\/actions\/([a-z-]+)@v2/g
      )) {
        wanted.add(name)
      }
    }

    expect([...wanted].sort()).toEqual(['gitops', 'publish-event', 'setup'])
    for (const name of wanted) {
      expect(existsSync(join(ACTIONS, name, 'action.yml'))).toBe(true)
    }
  })

  test('nothing is left of the pull request flow in the state workflows', () => {
    // release.yml and release-merge.yml still open and merge the release
    // pull request of ai-platform-infra and this repository.
    const stateFiles = everyFile().filter(
      (file) => !/release/.test(file) && !/infra-checks/.test(file)
    )

    for (const file of stateFiles) {
      expect(read(file)).not.toMatch(
        /abandon|enablePullRequestAutoMerge|pull-requests: write|permission-pull-requests|op\/\{/
      )
    }
    expect(existsSync(join(WORKFLOWS, 'prune-op-branches.yml'))).toBe(false)
  })
})

describe('submit-desired-state.yml', () => {
  const file = 'submit-desired-state.yml'

  test('takes revert, cdp_request_id and expected_base, and an optional operation_id', () => {
    const text = read(`.github/workflows/${file}`)

    expect(text).toMatch(/description: write, remove or revert\./)
    expect(text).toMatch(/^ {6}cdp_request_id:$/m)
    expect(text).toMatch(/^ {6}expected_base:$/m)
    expect(text).toMatch(
      /^ {6}operation_id:\n(?: {8}.+\n)*? {8}required: false$/m
    )
  })

  test('runs in the {env}-events Environment with no pull-requests permission', () => {
    const submit = job(file, 'submit')

    expect(submit).toMatch(
      /^ {4}environment:\n {6}name: \$\{\{ inputs\.environment \}\}-events$/m
    )
    expect(submit).toMatch(
      /^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}env:/m
    )
    expect(submit).not.toContain('pull-requests')
    expect(submit).toContain('queue: max')
  })

  test('mints a token that can only write contents', () => {
    const writer = read(`.github/workflows/${file}`).match(
      /id: writer\n(?:.*\n)*?\n/
    )[0]

    expect(writer).toContain('permission-contents: write')
    expect(writer).not.toMatch(/permission-(?!contents)/)
  })

  test('checks who dispatched before it mints a token or names an Environment', () => {
    const access = job(file, 'access')

    expect(access).toContain('command: admin-check')
    expect(access).toContain('AIP_ADMIN_SCOPE: submit')
    expect(access).not.toContain('create-github-app-token')
    expect(job(file, 'submit')).toMatch(/^ {4}needs: access$/m)
  })

  test('sends requested, committed and a retryable refusal, and nothing on a commit conflict', () => {
    const text = job(file, 'submit')

    for (const status of ['requested', 'committed', 'checks-failed']) {
      expect(text).toMatch(new RegExp(`status: ${status}$`, 'm'))
    }
    expect(text).toContain(
      `contains(fromJSON('["checks-failed","stale-revision","paused"]'), env.AIP_FAILURE_CODE)`
    )
    expect(text).not.toContain('commit-conflict"')
  })

  test('uploads a report that holds only the events', () => {
    expect(job(file, 'submit')).toContain(
      'name: run-report-${{ inputs.environment }}.json'
    )
  })
})

describe('apply-state.yml', () => {
  const file = 'apply-state.yml'

  test('takes all, for reconcile-all, and keeps the break-glass inputs', () => {
    const text = read(`.github/workflows/${file}`)

    expect(text).toMatch(/^ {6}all:\n(?: {8}.+\n)*? {8}type: boolean$/m)
    expect(text).toMatch(/^ {6}allow_destroy:$/m)
    expect(text).toMatch(/^ {6}force_unlock:$/m)
  })

  test('checks who dispatched before it resolves anything, passing the caller workflow for reconcile-all', () => {
    const access = job(file, 'access')

    expect(access).toContain('AIP_ADMIN_SCOPE: apply')
    expect(access).toContain('AIP_WORKFLOW_REF: ${{ github.workflow_ref }}')
    expect(access).toContain(
      "AIP_BREAK_GLASS_INPUTS: ${{ inputs.allow_destroy || inputs.force_unlock != '' }}"
    )
    expect(job(file, 'resolve')).toMatch(/^ {4}needs: access$/m)
  })

  test('reads each environment pause in its {env}-events Environment before the apply starts', () => {
    const gate = job(file, 'gate')

    expect(gate).toMatch(
      /^ {4}environment:\n {6}name: \$\{\{ matrix\.environment \}\}-events$/m
    )
    expect(gate).toContain('command: pause-gate')
    expect(job(file, 'apply')).toMatch(/^ {4}needs: \[resolve, gate\]$/m)
  })

  test('the apply job runs in the real Environment, never the events one', () => {
    expect(job(file, 'apply')).toMatch(
      /^ {4}environment:\n {6}name: \$\{\{ matrix\.environment \}\}$/m
    )
  })

  test('the ruleset check gets a token that can read the rulesets, and only that', () => {
    const checker = read(`.github/workflows/${file}`).match(
      /id: checker\n(?:.*\n)*?\n/
    )[0]

    expect(checker).toContain('permission-administration: read')
    expect(checker).not.toMatch(/permission-(?!administration)/)
    expect(job(file, 'apply')).toContain(
      'app-token: ${{ steps.checker.outputs.token }}'
    )
  })

  test('sends deploying after the pause check, and deployed or deploy-failed after the report, each once', () => {
    const text = job(file, 'apply')
    const order = [
      'command: preflight',
      'apply.sh" operations',
      'command: held',
      'status: deploy-failed',
      'status: deploying',
      'apply.sh" plan',
      'apply.sh" apply',
      'apply.sh" report',
      "'deployed' || 'deploy-failed'"
    ].map((marker) => text.indexOf(marker))

    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('sends nothing for a cancelled run or one stopped at its preflight, nor when held', () => {
    const text = job(file, 'apply')
    const final = text.match(
      /Tell the Portal API how the apply ended\n {8}if: >-\n((?: {10}.+\n)+)/
    )[1]

    expect(final).toContain('!cancelled()')
    expect(final).toContain("steps.preflight.outcome == 'success'")
    expect(final).toContain("env.AIP_HELD != 'true'")
  })

  test('holds back plan, apply and the report while the environment is paused for an App', () => {
    const text = job(file, 'apply')

    for (const step of ['id: plan', 'id: apply']) {
      expect(text).toMatch(
        new RegExp(`${step}\\n {8}if: env\\.AIP_HELD != 'true'`)
      )
    }
    expect(text).toContain(
      "if: always() && env.AIP_SCRIPTS != '' && env.AIP_HELD != 'true'"
    )
  })
})

describe('pause.yml', () => {
  const file = 'pause.yml'

  test('is a reusable workflow that takes the environment', () => {
    const text = read(`.github/workflows/${file}`)

    expect(text).toContain('  workflow_call:')
    expect(text).toMatch(
      /^ {6}environment:\n(?: {8}.+\n)*? {8}required: true$/m
    )
  })

  test('is for admins, checked before the Environment is named', () => {
    expect(job(file, 'access')).toContain('AIP_ADMIN_SCOPE: pause')
    expect(job(file, 'pause')).toMatch(/^ {4}needs: access$/m)
  })

  test('announces paused or resumed from AIP_PAUSED and writes nothing', () => {
    const pause = job(file, 'pause')

    expect(pause).toContain(
      "status: ${{ vars.AIP_PAUSED == 'true' && 'paused' || 'resumed' }}"
    )
    expect(pause).toMatch(
      /^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m
    )
    expect(pause).toContain('AIP_EVENT_SOURCE: pause')
  })
})

describe('validate-desired-state.yml', () => {
  test('skips the file checks for a pull request that changes nothing under environments/', () => {
    const text = read('.github/workflows/validate-desired-state.yml')

    expect(text.match(/if: env\.AIP_SKIP_VALIDATION != 'true'/g)).toHaveLength(
      3
    )
    expect(text).toMatch(/^ {4}name: validate$/m)
  })
})

describe('the publish-event action', () => {
  const action = read('.github/actions/publish-event/action.yml')

  test('takes the inputs the contract names', () => {
    for (const input of [
      'status',
      'operation-ids',
      'run-report',
      'failure-code',
      'failure-message'
    ]) {
      expect(action).toMatch(new RegExp(`^ {2}${input}:$`, 'm'))
    }
  })

  test('never fails a deploy: every step after the build is continue-on-error', () => {
    expect(action.match(/continue-on-error: true/g)).toHaveLength(3)
  })

  test('signs in as the events identity with no subscription, and sends with the script', () => {
    expect(action).toContain('client-id: ${{ env.AIP_EVENTS_CLIENT_ID }}')
    expect(action).toContain('allow-no-subscriptions: true')
    expect(action).toContain('scripts/publish-event.sh')
  })
})
