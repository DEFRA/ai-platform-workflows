import { createWorkspace } from '../../helpers/scripts.js'

// 2026-10-26T12:00:00Z
const NOW = 1793016000
const HOUR_MS = 3600_000

let workspace

beforeEach(() => {
  workspace = createWorkspace()
})

afterEach(() => workspace.cleanup())

function event(action, hoursAgo, actor = 'an-admin') {
  return { '@timestamp': NOW * 1000 - hoursAgo * HOUR_MS, action, actor }
}

function audit(events, args = []) {
  workspace.write(
    'gh-fixtures/orgs_DEFRA_audit-log.json',
    JSON.stringify(events)
  )

  return workspace.run(
    'setup/audit-log.sh',
    ['--repos', 'ai-platform-tenants', ...args],
    { AIP_NOW: String(NOW) }
  )
}

describe('audit-log.sh', () => {
  test('is quiet when nothing watched changed', () => {
    const result = audit([
      event('repo.create', 1),
      event('git.clone', 2),
      event('repository_ruleset.update', 40)
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No watched change in the last 26 hours.')
  })

  test.each([
    'repository_ruleset.update',
    'repository_ruleset.create',
    'repository_ruleset.destroy',
    'protected_branch.update_admin_enforced',
    'protected_branch.policy_override',
    'required_status_check.destroy',
    'environment.update_protection_rule',
    'environment.update_actions_variable',
    'repo.update_actions_settings',
    'repo.actions_enabled',
    'repo.add_member',
    'repo.update_member',
    'repo.update_default_branch',
    'team.add_repository',
    'team.update_repository_permission',
    'public_key.create',
    'public_key.delete',
    'hook.create',
    'hook.config_changed'
  ])('alerts on %s, naming who did it', (action) => {
    const result = audit([event(action, 3, 'an-admin')])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      `::error::ai-platform-tenants: ${action} by an-admin at 2026-10-26T09:00:00Z`
    )
  })

  test.each([
    'protected_branch.rejected_ref_update',
    'repo.access',
    'repo.create',
    'team.add_member',
    'public_key.verify',
    'org.update_actions_settings'
  ])('does not alert on %s', (action) => {
    expect(audit([event(action, 3)]).status).toBe(0)
  })

  test('looks only at the window: an event from before it is left to the run that saw it', () => {
    const result = audit([
      event('repository_ruleset.update', 25.5),
      event('hook.create', 26.5)
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('repository_ruleset.update')
    expect(result.stdout).not.toContain('hook.create')
  })

  test('asks for the repository and the day of the window start', () => {
    audit([])

    expect(workspace.commands()).toContainEqual(
      expect.stringContaining(
        'gh api -X GET orgs/DEFRA/audit-log -f phrase=repo:DEFRA/ai-platform-tenants created:>=2026-10-25 --paginate'
      )
    )
  })

  test('names an actor GitHub did not record as unknown', () => {
    const result = audit([
      { '@timestamp': NOW * 1000 - HOUR_MS, action: 'hook.destroy' }
    ])

    expect(result.stdout).toContain('hook.destroy by unknown')
  })

  test('refuses an hours window that is not a number, and an unknown argument', () => {
    expect(audit([], ['--hours', 'a day']).status).toBe(1)
    expect(
      workspace.run('setup/audit-log.sh', ['--since', 'yesterday']).status
    ).toBe(1)
  })
})
