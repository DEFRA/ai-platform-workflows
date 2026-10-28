const MAX_RESOURCES = 500

function entry(type, name, id) {
  return name && id ? [{ type, name: String(name), id: String(id) }] : []
}

/**
 * What an apply published for one team, as the event's `resources[]`: the
 * team's `outputs.teams.value[slug]` in the run report (infra
 * `modules/team` output `resources`) flattened into `{type, name, id}`, the
 * form the Portal API verifies by ARM reads. The type names are the ones in
 * infra `schemas/messages/examples/event-deployed.json`, and the worker's
 * reconciler flattens the same report the same way, so a `deployed` from
 * either looks alike. A removal, a pin or a team the outputs do not name has
 * none.
 *
 * @param {object | null} report - The run report.
 * @param {string | null} team - The team slug.
 * @returns {Array<{type: string, name: string, id: string}>} Resources.
 */
function resourcesOf(report, team) {
  const outputs = report?.outputs?.teams?.value?.[team]

  if (!outputs) {
    return []
  }

  const { project, deployments, api, registration } = outputs

  return [
    ...entry('azapi_resource.foundry_project', project?.name, project?.id),
    ...Object.values(deployments ?? {}).flatMap((deployment) =>
      entry('azurerm_cognitive_deployment', deployment.name, deployment.id)
    ),
    ...entry('azurerm_api_management_api', api?.name, api?.id),
    ...entry('azuread_application', team, registration?.object_id),
    ...entry(
      'azuread_service_principal',
      team,
      registration?.service_principal_object_id
    )
  ].slice(0, MAX_RESOURCES)
}

export { resourcesOf }
