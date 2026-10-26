import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createWorkspace, SCRIPTS } from '../../helpers/scripts.js'

// Each run makes dozens of calls to the fakes, which is slow on Windows.
vi.setConfig({ testTimeout: 180_000 })

let workspace

beforeEach(() => {
  workspace = createWorkspace()
})

afterEach(() => workspace.cleanup())

const SCRIPT = 'setup/repo-settings.sh'
const APP = '5059913'
const SUBMIT_APPS = '111,222'
const TENANTS = 'ai-platform-tenants'

function run(args, script = SCRIPT) {
  return workspace.run(script, ['--app-id', APP, ...args])
}

function runMachine(args = []) {
  return run([
    '--environments',
    'infradev',
    '--submit-app-ids',
    SUBMIT_APPS,
    '--repos',
    TENANTS,
    ...args
  ])
}

function writes() {
  return workspace
    .commands()
    .filter((line) => / -X (PUT|POST|PATCH|DELETE) /.test(line))
}

function bodies() {
  return workspace
    .commands()
    .filter((line) => line.startsWith('body '))
    .map((line) => JSON.parse(line.slice(5)))
}

function template(name) {
  return JSON.parse(
    readFileSync(join(SCRIPTS, 'setup', 'rulesets', `${name}.json`), 'utf8')
  )
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

  test('no longer knows an engineers team: nobody but the submit Apps bypasses machine main', () => {
    const result = run([
      '--environments',
      'infradev',
      '--engineers-team',
      '12568379'
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::unknown argument --engineers-team'
    )
  })

  test.each([
    [
      ['--submit-app-ids', 'the-app'],
      '--submit-app-ids must be the numeric IDs'
    ],
    [['--admins-team', 'Not A Team'], '--admins-team must be the GitHub team'],
    [[], '--submit-app-ids is needed for ai-platform-tenants']
  ])('refuses %j', (extra, message) => {
    const result = run([
      '--environments',
      'infradev',
      '--repos',
      TENANTS,
      ...extra
    ])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(message)
    expect(writes().filter((line) => line.includes('rulesets'))).toEqual([])
  })

  test('sets squash-only merging, both machine rulesets, both Environments per environment and the admins team in a machine repository', () => {
    const result = runMachine(['--environments', 'infradev,dev'])

    expect(result.status).toBe(0)
    const lines = writes()
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^gh api -X PATCH repos\/DEFRA\/ai-platform-tenants -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true/
      )
    )
    expect(
      lines.filter((line) => line.endsWith('/rulesets --input -'))
    ).toHaveLength(2)
    for (const environment of [
      'infradev',
      'infradev-events',
      'dev',
      'dev-events'
    ]) {
      expect(lines).toContainEqual(
        `gh api -X PUT repos/DEFRA/ai-platform-tenants/environments/${environment} --input -`
      )
      expect(lines).toContainEqual(
        `gh api -X POST repos/DEFRA/ai-platform-tenants/environments/${environment}/deployment-branch-policies -f name=main -f type=branch`
      )
    }
    expect(lines).toContainEqual(
      'gh api -X PUT orgs/DEFRA/teams/aice-platform-admins/repos/DEFRA/ai-platform-tenants -f permission=admin'
    )
    expect(lines).not.toContainEqual(expect.stringContaining('DELETE'))
    expect(result.stdout).toContain(
      'ai-platform-tenants: ruleset aip-machine-main created'
    )
    expect(result.stdout).toContain(
      'ai-platform-tenants: ruleset aip-machine-protect created'
    )
  })

  test("sets up both machine repositories alike, with a team of the caller's choosing", () => {
    const result = run([
      '--environments',
      'infradev',
      '--submit-app-ids',
      SUBMIT_APPS,
      '--admins-team',
      'platform-admins',
      '--repos',
      'ai-platform-tenants,ai-platform-deployments'
    ])

    expect(result.status).toBe(0)
    for (const repo of ['ai-platform-tenants', 'ai-platform-deployments']) {
      expect(writes()).toContainEqual(
        `gh api -X PUT orgs/DEFRA/teams/platform-admins/repos/DEFRA/${repo} -f permission=admin`
      )
    }
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
      '--submit-app-ids',
      SUBMIT_APPS,
      '--repos',
      'ai-platform-deployments'
    ])

    expect(result.status).toBe(0)
    const lines = writes()
    expect(lines).toContainEqual(
      'gh api -X PUT repos/DEFRA/ai-platform-deployments/rulesets/2 --input -'
    )
    expect(lines).toContainEqual(
      'gh api -X POST repos/DEFRA/ai-platform-deployments/rulesets --input -'
    )
    expect(lines).toContainEqual(
      'gh api -X DELETE repos/DEFRA/ai-platform-deployments/environments/gitops-reader'
    )
    expect(lines).not.toContainEqual(
      expect.stringContaining(
        'infradev/deployment-branch-policies -f name=main'
      )
    )
    expect(result.stdout).toContain('ruleset aip-machine-main updated')
    expect(result.stdout).toContain('ruleset aip-machine-protect created')
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
    expect(result.stdout).not.toContain('aice-platform-admins')
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

    const result = runMachine(['--dry-run'])

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

    const result = runMachine()

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
  const bodyNamed = (name) => bodies().find((body) => body.name === name)

  test('aip-machine-main needs a pull request with one approval and a code-owner review, and the validate check, and only the submit Apps bypass it', () => {
    expect(runMachine().status).toBe(0)

    const main = bodyNamed('aip-machine-main')
    expect(main.bypass_actors).toEqual([
      { actor_id: 111, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: 222, actor_type: 'Integration', bypass_mode: 'always' }
    ])
    expect(main.rules).toContainEqual(
      expect.objectContaining({
        type: 'pull_request',
        parameters: expect.objectContaining({
          required_approving_review_count: 1,
          require_code_owner_review: true,
          allowed_merge_methods: ['squash']
        })
      })
    )
    expect(main.rules).toContainEqual({
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
    expect(main.rules.map((rule) => rule.type)).toEqual([
      'pull_request',
      'required_status_checks'
    ])
  })

  test('aip-machine-protect blocks force pushes and deletion and has no bypass actor at all', () => {
    expect(runMachine().status).toBe(0)

    const protect = bodyNamed('aip-machine-protect')
    expect(protect.bypass_actors).toEqual([])
    expect(protect.rules.map((rule) => rule.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'required_linear_history'
    ])
    expect(protect.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH'])
  })

  test('no ruleset of a machine repository lists a person, a team or a role', () => {
    expect(runMachine().status).toBe(0)

    for (const body of bodies().filter((entry) => entry.rules)) {
      expect(body.bypass_actors.map((actor) => actor.actor_type)).toEqual(
        body.bypass_actors.map(() => 'Integration')
      )
    }
  })

  test('administrators cannot bypass the protection of any Environment, the events ones included', () => {
    expect(runMachine(['--environments', 'infradev,dev']).status).toBe(0)

    const environmentBodies = bodies().filter(
      (body) => body.deployment_branch_policy
    )
    expect(environmentBodies).toHaveLength(4)
    for (const body of environmentBodies) {
      expect(body).toEqual({
        can_admins_bypass: false,
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true
        }
      })
    }
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

describe('AIP_PAUSED', () => {
  const variable = (environment) =>
    `gh api -X POST repos/DEFRA/ai-platform-tenants/environments/${environment}/variables -f name=AIP_PAUSED -f value=false`

  test('starts false in each {env}-events Environment, and in no other', () => {
    expect(runMachine(['--environments', 'infradev,dev']).status).toBe(0)

    const lines = writes().filter((line) => line.includes('/variables'))
    expect(lines).toEqual([variable('infradev-events'), variable('dev-events')])
  })

  test('is never reset when an admin already set it', () => {
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_environments_infradev-events_variables_AIP_PAUSED.json',
      '{"name":"AIP_PAUSED","value":"true"}'
    )

    expect(runMachine().status).toBe(0)

    expect(writes().filter((line) => line.includes('/variables'))).toEqual([])
  })
})

describe('the assertion on bypass actors', () => {
  test('stops before any write when a body would let anyone but the named Apps bypass', () => {
    // A copy of the script whose App bypass list names a team instead.
    const dir = join(workspace.dir, 'setup')
    workspace.write('setup/placeholder', '')
    const copy = (name) =>
      workspace.write(
        `setup/${name}`,
        readFileSync(join(SCRIPTS, 'setup', name), 'utf8')
      )
    copy('repositories.json')
    for (const name of ['machine-main', 'machine-protect']) {
      workspace.write(
        `setup/rulesets/${name}.json`,
        readFileSync(join(SCRIPTS, 'setup', 'rulesets', `${name}.json`), 'utf8')
      )
    }
    workspace.write(
      'setup/repo-settings.sh',
      readFileSync(join(SCRIPTS, SCRIPT), 'utf8').replace(
        'actor_type: "Integration", bypass_mode: $mode',
        'actor_type: "Team", bypass_mode: $mode'
      )
    )

    const result = run(
      [
        '--environments',
        'infradev',
        '--submit-app-ids',
        SUBMIT_APPS,
        '--repos',
        TENANTS
      ],
      relative(SCRIPTS, join(dir, 'repo-settings.sh')).replaceAll('\\', '/')
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: aip-machine-main would let someone other than the named Apps bypass it; stopping before any write'
    )
    expect(writes().filter((line) => line.includes('rulesets'))).toEqual([])
  })
})

describe('--verify', () => {
  // An Environment as GitHub returns it when the script has set it.
  function environmentBody(overrides = {}) {
    return JSON.stringify({
      can_admins_bypass: false,
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true
      },
      ...overrides
    })
  }

  // The live state of a machine repository exactly as the script sets it.
  function liveMatches(skip = [], repo = TENANTS, environments = ['infradev']) {
    const prefix = `gh-fixtures/repos_DEFRA_${repo}`
    const put = (path, text) => {
      if (!skip.some((name) => path.endsWith(`${name}.json`))) {
        workspace.write(path, text)
      }
    }
    const main = {
      ...template('machine-main'),
      id: 1,
      bypass_actors: [111, 222].map((id) => ({
        actor_id: id,
        actor_type: 'Integration',
        bypass_mode: 'always'
      }))
    }
    const protect = { ...template('machine-protect'), id: 2 }

    put(
      `${prefix}_rulesets.json`,
      JSON.stringify([
        { id: 1, name: 'aip-machine-main' },
        { id: 2, name: 'aip-machine-protect' }
      ])
    )
    put(`${prefix}_rulesets_1.json`, JSON.stringify(main))
    put(`${prefix}_rulesets_2.json`, JSON.stringify(protect))

    for (const environment of environments) {
      for (const name of [environment, `${environment}-events`]) {
        put(`${prefix}_environments_${name}.json`, environmentBody())
        put(
          `${prefix}_environments_${name}_deployment-branch-policies.json`,
          '{"branch_policies":[{"id":1,"name":"main","type":"branch"}]}'
        )
      }
      put(
        `${prefix}_environments_${environment}-events_variables_AIP_PAUSED.json`,
        '{"name":"AIP_PAUSED","value":"false"}'
      )
    }

    put(
      `gh-fixtures/orgs_DEFRA_teams_aice-platform-admins_repos_DEFRA_${repo}.json`,
      '{"role_name":"admin"}'
    )
  }

  const verify = () => runMachine(['--verify'])

  // aip-machine-main as the script sets it, with the submit Apps bypassing.
  function liveMain(overrides = {}) {
    return {
      ...template('machine-main'),
      id: 1,
      bypass_actors: [111, 222].map((id) => ({
        actor_id: id,
        actor_type: 'Integration',
        bypass_mode: 'always'
      })),
      ...overrides
    }
  }

  test('passes when GitHub adds parameters of its own, and lists in another order', () => {
    liveMatches()
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_rulesets_1.json',
      JSON.stringify(
        liveMain({
          rules: template('machine-main').rules.map((rule) => ({
            ...rule,
            parameters: {
              ...rule.parameters,
              automatic_copilot_code_review_enabled: false
            }
          }))
        })
      )
    )

    const result = verify()

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('::error::')
  })

  test('passes, writing nothing, when the repository is as the script would set it', () => {
    liveMatches()

    const result = verify()

    expect(result.status).toBe(0)
    expect(writes()).toEqual([])
    expect(result.stdout).not.toContain('::error::')
    expect(result.stdout).toContain('dry-run: gh api -X PATCH')
  })

  test('reports a person on the bypass list of a ruleset, and the machine ruleset that no longer matches', () => {
    liveMatches()
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_rulesets_1.json',
      JSON.stringify({
        ...template('machine-main'),
        id: 1,
        bypass_actors: [
          { actor_id: 111, actor_type: 'Integration', bypass_mode: 'always' },
          { actor_id: 222, actor_type: 'Integration', bypass_mode: 'always' },
          { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }
        ]
      })
    )

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: ruleset aip-machine-main is not as this script sets it'
    )
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: ruleset aip-machine-main lets a person, a team or a role bypass it'
    )
  })

  test('reports a ruleset someone added that lets a team bypass it, whatever its name', () => {
    liveMatches()
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_rulesets.json',
      JSON.stringify([
        { id: 1, name: 'aip-machine-main' },
        { id: 2, name: 'aip-machine-protect' },
        { id: 3, name: 'Hotfix' }
      ])
    )
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_rulesets_3.json',
      JSON.stringify({
        bypass_actors: [
          { actor_id: 9, actor_type: 'Team', bypass_mode: 'always' }
        ]
      })
    )

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: ruleset Hotfix lets a person, a team or a role bypass it'
    )
  })

  test.each([
    [
      'a ruleset is missing',
      'rulesets',
      JSON.stringify([{ id: 1, name: 'aip-machine-main' }]),
      'ruleset aip-machine-protect is missing'
    ],
    [
      'a rule was removed',
      'rulesets_2',
      JSON.stringify({
        ...template('machine-protect'),
        rules: [{ type: 'deletion' }]
      }),
      'ruleset aip-machine-protect is not as this script sets it'
    ],
    [
      'a ruleset was switched off',
      'rulesets_2',
      JSON.stringify({
        ...template('machine-protect'),
        enforcement: 'disabled'
      }),
      'ruleset aip-machine-protect is not as this script sets it'
    ],
    [
      'the code-owner review was relaxed',
      'rulesets_1',
      JSON.stringify({
        ...template('machine-main'),
        bypass_actors: [111, 222].map((id) => ({
          actor_id: id,
          actor_type: 'Integration',
          bypass_mode: 'always'
        })),
        rules: template('machine-main').rules.map((rule) =>
          rule.type === 'pull_request'
            ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  require_code_owner_review: false
                }
              }
            : rule
        )
      }),
      'ruleset aip-machine-main is not as this script sets it'
    ],
    [
      'the required check was renamed to a longer name that contains it',
      'rulesets_1',
      JSON.stringify(
        liveMain({
          rules: template('machine-main').rules.map((rule) =>
            rule.type === 'required_status_checks'
              ? {
                  ...rule,
                  parameters: {
                    ...rule.parameters,
                    required_status_checks: [
                      {
                        context: 'validate-desired-state / validate-other',
                        integration_id: 15368
                      }
                    ]
                  }
                }
              : rule
          )
        })
      ),
      'ruleset aip-machine-main is not as this script sets it'
    ],
    [
      'a ruleset also covers another branch',
      'rulesets_1',
      JSON.stringify(
        liveMain({
          conditions: {
            ref_name: {
              include: ['~DEFAULT_BRANCH', 'refs/heads/dev'],
              exclude: []
            }
          }
        })
      ),
      'ruleset aip-machine-main is not as this script sets it'
    ],
    [
      'a ruleset excludes the default branch',
      'rulesets_2',
      JSON.stringify({
        ...template('machine-protect'),
        conditions: {
          ref_name: {
            include: ['~DEFAULT_BRANCH'],
            exclude: ['~DEFAULT_BRANCH']
          }
        }
      }),
      'ruleset aip-machine-protect is not as this script sets it'
    ],
    [
      'an Environment lets administrators bypass',
      'environments_infradev-events',
      environmentBody({ can_admins_bypass: true }),
      'Environment infradev-events lets administrators bypass its protection'
    ],
    [
      'an Environment keeps its main policy but is unrestricted',
      'environments_infradev',
      environmentBody({ deployment_branch_policy: null }),
      'Environment infradev does not enforce its custom branch policies'
    ],
    [
      'an Environment keeps its main policy but is limited to protected branches',
      'environments_infradev-events',
      environmentBody({
        deployment_branch_policy: {
          protected_branches: true,
          custom_branch_policies: false
        }
      }),
      'Environment infradev-events does not enforce its custom branch policies'
    ],
    [
      'an Environment allows another branch',
      'environments_infradev_deployment-branch-policies',
      '{"branch_policies":[{"id":1,"name":"main","type":"branch"},{"id":2,"name":"feature/*","type":"branch"}]}',
      'Environment infradev does not allow the branch main alone'
    ]
  ])('reports drift when %s', (_why, fixture, body, message) => {
    liveMatches()
    workspace.write(
      `gh-fixtures/repos_DEFRA_ai-platform-tenants_${fixture}.json`,
      body
    )

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`::error::ai-platform-tenants: ${message}`)
  })

  test('reports an Environment that is missing, and a pause that was never created', () => {
    liveMatches([
      '_environments_infradev',
      '_environments_infradev-events_variables_AIP_PAUSED'
    ])

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: Environment infradev is missing'
    )
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: Environment infradev-events has no AIP_PAUSED'
    )
  })

  test('reports the admins team when it is not repository admin', () => {
    liveMatches()
    workspace.write(
      'gh-fixtures/orgs_DEFRA_teams_aice-platform-admins_repos_DEFRA_ai-platform-tenants.json',
      '{"role_name":"push"}'
    )

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '::error::ai-platform-tenants: aice-platform-admins is not repository admin (it is push)'
    )
  })

  test('reports every difference, not only the first', () => {
    liveMatches()
    workspace.write(
      'gh-fixtures/repos_DEFRA_ai-platform-tenants_environments_infradev.json',
      environmentBody({ can_admins_bypass: true })
    )
    workspace.write(
      'gh-fixtures/orgs_DEFRA_teams_aice-platform-admins_repos_DEFRA_ai-platform-tenants.json',
      '{"role_name":"push"}'
    )

    const result = verify()

    expect(result.status).toBe(1)
    expect(result.stdout.match(/::error::/g)).toHaveLength(2)
  })
})
