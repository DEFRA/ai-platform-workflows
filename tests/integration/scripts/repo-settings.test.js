import { createWorkspace } from '../../helpers/scripts.js'

let workspace

beforeEach(() => {
  workspace = createWorkspace()
})

afterEach(() => workspace.cleanup())

const SCRIPT = 'setup/repo-settings.sh'
const APP = '5059913'

function run(args) {
  return workspace.run(SCRIPT, ['--app-id', APP, ...args])
}

function writes() {
  return workspace
    .commands()
    .filter((line) => / -X (PUT|POST|PATCH|DELETE) /.test(line))
}

describe('repo-settings.sh', () => {
  test('refuses to run without the App ID and the real environments', () => {
    expect(workspace.run(SCRIPT, ['--environments', 'infradev']).status).toBe(1)
    expect(workspace.run(SCRIPT, ['--app-id', APP]).status).toBe(1)
    expect(
      workspace.run(SCRIPT, ['--app-id', 'app', '--environments', 'infradev'])
        .stdout
    ).toContain('::error::--app-id must be the GitHub App')
  })

  test('sets squash-only merging with auto-merge, and requires the validate check in a machine repository', () => {
    const result = run([
      '--environments',
      'infradev,dev',
      '--repos',
      'ai-platform-tenants'
    ])

    expect(result.status).toBe(0)
    const lines = writes()
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^gh api -X PATCH repos\/DEFRA\/ai-platform-tenants -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true/
      )
    )
    expect(lines).toContainEqual(
      'gh api -X POST repos/DEFRA/ai-platform-tenants/rulesets --input -'
    )
    expect(lines).toContainEqual(
      'gh api -X PUT repos/DEFRA/ai-platform-tenants/environments/infradev --input -'
    )
    expect(lines).toContainEqual(
      'gh api -X POST repos/DEFRA/ai-platform-tenants/environments/infradev/deployment-branch-policies -f name=main -f type=branch'
    )
    expect(lines).toContainEqual(
      'gh api -X PUT repos/DEFRA/ai-platform-tenants/environments/dev --input -'
    )
    expect(lines).not.toContainEqual(expect.stringContaining('DELETE'))
    expect(result.stdout).toContain(
      'ai-platform-tenants: ruleset aip-machine-main created'
    )
  })

  test('replaces a ruleset of the same name and removes a legacy Environment', () => {
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-deployments_rulesets.json',
      JSON.stringify([
        { id: 1, name: 'Main' },
        { id: 2, name: 'aip-machine-main' }
      ])
    )
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-deployments_environments_gitops-reader.json',
      '{"name":"gitops-reader"}'
    )
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-deployments_environments_infradev_deployment-branch-policies.json',
      '{"branch_policies":[{"id":5,"name":"main"}]}'
    )

    const result = run([
      '--environments',
      'infradev',
      '--repos',
      'ai-platform-deployments'
    ])

    expect(result.status).toBe(0)
    const lines = writes()
    expect(lines).toContainEqual(
      'gh api -X PUT repos/DEFRA/ai-platform-deployments/rulesets/2 --input -'
    )
    expect(lines).toContainEqual(
      'gh api -X DELETE repos/DEFRA/ai-platform-deployments/environments/gitops-reader'
    )
    expect(lines).not.toContainEqual(
      expect.stringContaining('deployment-branch-policies -f name=main')
    )
    expect(result.stdout).toContain('ruleset aip-machine-main updated')
  })

  test('gives a human repository its checks, the App as the release bypass actor and the tag ruleset', () => {
    const result = run([
      '--environments',
      'infradev',
      '--repos',
      'ai-platform-infra',
      '--dry-run'
    ])

    expect(result.status).toBe(0)
    expect(writes()).toEqual([])
    expect(result.stdout).toContain(
      'dry-run: gh api -X POST repos/DEFRA/ai-platform-infra/rulesets --input -'
    )
    expect(result.stdout).toContain(
      'ai-platform-infra: ruleset aip-human-main created'
    )
    expect(result.stdout).toContain(
      'ai-platform-infra: ruleset aip-release-tags created'
    )
    expect(result.stdout).toContain(
      'ai-platform-infra: ruleset aip-release-branch created'
    )
    expect(result.stdout).not.toContain('Environment infradev allows main only')
  })

  test('warns about a disabled workflow, which dispatches fail on', () => {
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_actions_workflows.json',
      JSON.stringify({
        workflows: [
          { path: '.github/workflows/apply.yml', state: 'disabled_manually' },
          { path: '.github/workflows/submit.yml', state: 'active' }
        ]
      })
    )

    const result = run([
      '--environments',
      'infradev',
      '--repos',
      'ai-platform-tenants',
      '--dry-run'
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      '::warning::ai-platform-tenants has disabled workflows; dispatches to them fail with workflow-disabled:'
    )
    expect(result.stdout).toContain(
      '.github/workflows/apply.yml (disabled_manually)'
    )
    expect(result.stdout).not.toContain('submit.yml')
  })

  test('refuses a repository the manifest does not know, writing nothing to it', () => {
    const result = run(['--environments', 'infradev', '--repos', 'other'])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::other is not in')
    expect(writes()).toEqual([])
  })

  test('removes every deployment branch policy but the branch named main, a tag of that name included', () => {
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_environments_infradev_deployment-branch-policies.json',
      JSON.stringify({
        branch_policies: [
          { id: 11, name: 'feature/*', type: 'branch' },
          { id: 12, name: 'main', type: 'tag' },
          { id: 13, name: 'v*', type: 'tag' }
        ]
      })
    )

    const result = run([
      '--environments',
      'infradev',
      '--repos',
      'ai-platform-tenants'
    ])

    expect(result.status).toBe(0)
    const lines = writes()
    for (const id of [11, 12, 13]) {
      expect(lines).toContainEqual(
        `gh api -X DELETE repos/DEFRA/ai-platform-tenants/environments/infradev/deployment-branch-policies/${id}`
      )
    }
    expect(lines).toContainEqual(
      'gh api -X POST repos/DEFRA/ai-platform-tenants/environments/infradev/deployment-branch-policies -f name=main -f type=branch'
    )
    expect(result.stdout).toContain(
      'ai-platform-tenants: Environment infradev no longer allows tag main'
    )
  })
})

describe('the ruleset bodies the script sends', () => {
  function bodies() {
    return workspace
      .commands()
      .filter((line) => line.startsWith('body '))
      .map((line) => JSON.parse(line.slice(5)))
  }

  test('require the validate check from Actions alone, with no bypass, in a machine repository', () => {
    expect(
      run(['--environments', 'infradev', '--repos', 'ai-platform-tenants'])
        .status
    ).toBe(0)

    const [ruleset] = bodies().filter(
      (body) => body.name === 'aip-machine-main'
    )
    expect(ruleset.bypass_actors).toEqual([])
    expect(ruleset.rules).toContainEqual({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [
          {
            context: 'validate-desired-state / validate',
            integration_id: 15368
          }
        ]
      }
    })
    expect(ruleset.rules).toContainEqual(
      expect.objectContaining({
        type: 'pull_request',
        parameters: expect.objectContaining({
          required_approving_review_count: 0,
          allowed_merge_methods: ['squash']
        })
      })
    )
  })

  test('let the engineers team, when named, bypass machine main through a pull request only, never the App', () => {
    expect(
      run([
        '--environments',
        'infradev',
        '--engineers-team',
        '12568379',
        '--repos',
        'ai-platform-tenants'
      ]).status
    ).toBe(0)

    const [ruleset] = bodies().filter(
      (body) => body.name === 'aip-machine-main'
    )
    expect(ruleset.bypass_actors).toEqual([
      { actor_id: 12568379, actor_type: 'Team', bypass_mode: 'pull_request' }
    ])
  })

  test('refuse an engineers team that is not a numeric ID', () => {
    const result = run([
      '--environments',
      'infradev',
      '--engineers-team',
      'ai-dev-team'
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::--engineers-team must be the GitHub team'
    )
  })

  test('carry the checks and the App as pull-request bypass actor in a human repository, and the tag rules', () => {
    expect(
      run(['--environments', 'infradev', '--repos', 'ai-platform-infra']).status
    ).toBe(0)

    const [main] = bodies().filter((body) => body.name === 'aip-human-main')
    expect(main.bypass_actors).toEqual([
      {
        actor_id: 5059913,
        actor_type: 'Integration',
        bypass_mode: 'pull_request'
      }
    ])
    expect(
      main.rules.find((rule) => rule.type === 'required_status_checks')
        .parameters.required_status_checks
    ).toEqual([
      { context: 'infra-checks / validate', integration_id: 15368 },
      { context: 'infra-checks / lint', integration_id: 15368 },
      { context: 'infra-checks / schemas', integration_id: 15368 },
      { context: 'infra-checks / catalogue', integration_id: 15368 },
      { context: 'infra-checks / security', integration_id: 15368 }
    ])
    expect(
      main.rules.find((rule) => rule.type === 'pull_request').parameters
        .required_approving_review_count
    ).toBe(1)

    const [tags] = bodies().filter((body) => body.name === 'aip-release-tags')
    expect(tags.target).toBe('tag')
    expect(tags.conditions.ref_name.include).toEqual(['refs/tags/v*'])
    expect(tags.bypass_actors).toEqual([
      { actor_id: 5059913, actor_type: 'Integration', bypass_mode: 'always' }
    ])
    expect(tags.rules.map((rule) => rule.type)).toEqual([
      'creation',
      'update',
      'deletion'
    ])

    // The release branch is the App's alone, so the pull request it merges
    // through its bypass carries nobody else's commits.
    const [branch] = bodies().filter(
      (body) => body.name === 'aip-release-branch'
    )
    expect(branch.target).toBe('branch')
    expect(branch.conditions.ref_name.include).toEqual([
      'refs/heads/release-please--*'
    ])
    expect(branch.bypass_actors).toEqual([
      { actor_id: 5059913, actor_type: 'Integration', bypass_mode: 'always' }
    ])
    expect(branch.rules.map((rule) => rule.type)).toEqual([
      'creation',
      'update',
      'deletion',
      'non_fast_forward'
    ])
  })

  test('give a human repository that releases nothing no bypass actor', () => {
    expect(
      run(['--environments', 'infradev', '--repos', 'ai-platform-environments'])
        .status
    ).toBe(0)

    const [main] = bodies().filter((body) => body.name === 'aip-human-main')
    expect(main.bypass_actors).toEqual([])
    expect(
      main.rules.find((rule) => rule.type === 'required_status_checks')
        .parameters.required_status_checks
    ).toEqual([
      { context: 'validate-environments / validate', integration_id: 15368 }
    ])
    expect(
      bodies().some((body) =>
        ['aip-release-tags', 'aip-release-branch'].includes(body.name)
      )
    ).toBe(false)
  })
})
