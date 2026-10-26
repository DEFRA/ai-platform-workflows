import { resourcesOf } from '../../src/resources.js'

const REGISTRATION = {
  object_id: 'obj-1',
  service_principal_object_id: 'obj-2'
}

function reportOf(team) {
  return { outputs: { teams: { value: { alpha: team } } } }
}

describe('resourcesOf', () => {
  test('flattens the team outputs into typed resources', () => {
    expect(
      resourcesOf(
        reportOf({
          project: { id: '/p', name: 'aip-alpha' },
          deployments: { nano: { id: '/d', name: 'alpha-nano' } },
          api: { id: '/a', name: 'alpha' },
          registration: REGISTRATION
        }),
        'alpha'
      )
    ).toEqual([
      { type: 'azapi_resource.foundry_project', name: 'aip-alpha', id: '/p' },
      { type: 'azurerm_cognitive_deployment', name: 'alpha-nano', id: '/d' },
      { type: 'azurerm_api_management_api', name: 'alpha', id: '/a' },
      { type: 'azuread_application', name: 'alpha', id: 'obj-1' },
      { type: 'azuread_service_principal', name: 'alpha', id: 'obj-2' }
    ])
  })

  test('skips what Terraform did not create: no registration, no deployments, no name or ID', () => {
    expect(
      resourcesOf(
        reportOf({
          project: { id: '/p', name: 'aip-alpha' },
          deployments: { broken: { name: 'alpha-broken' } },
          api: null,
          registration: null
        }),
        'alpha'
      )
    ).toEqual([
      { type: 'azapi_resource.foundry_project', name: 'aip-alpha', id: '/p' }
    ])
    expect(resourcesOf(reportOf({}), 'alpha')).toEqual([])
  })

  test.each([
    ['no report', null, 'alpha'],
    ['no outputs', {}, 'alpha'],
    ['no entry for the team', { outputs: { teams: { value: {} } } }, 'alpha'],
    ['no team', reportOf({ project: { id: '/p', name: 'x' } }), null]
  ])('is empty for %s', (_why, report, team) => {
    expect(resourcesOf(report, team)).toEqual([])
  })

  test('keeps at most the 500 resources the schema allows', () => {
    const deployments = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [
        `d${index}`,
        { id: `/d${index}`, name: `n${index}` }
      ])
    )

    expect(resourcesOf(reportOf({ deployments }), 'alpha')).toHaveLength(500)
  })
})
