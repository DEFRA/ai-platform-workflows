// The GitOps documents the modules read, in the shape of the examples in
// ai-platform-infra (examples/, schema-valid there), reduced to the fields
// the modules use.

const INFRA_SHA = 'c'.repeat(40)

/**
 * ai-platform-environments registry.json.
 *
 * @param {object[]} [entries] - Registry entries; one Infradev entry by default.
 * @returns {object} The registry.
 */
function registry(entries = [registryEntry()]) {
  return { schemaVersion: 1, environments: entries }
}

/**
 * One registry entry.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The entry.
 */
function registryEntry(overrides = {}) {
  return {
    name: 'infradev',
    class: 'platform-test',
    autoPin: true,
    entra: { enabled: true, tenantId: '00000000-0000-0000-0000-000000000000' },
    runner: { labels: ['ubuntu-26.04'] },
    ...overrides
  }
}

/**
 * ai-platform-deployments environments/{env}/platform.json.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The pin.
 */
function pin(overrides = {}) {
  return {
    schemaVersion: 1,
    environment: 'infradev',
    release: 'v0.4.0',
    sha: INFRA_SHA,
    previousRelease: 'v0.3.0',
    requestedBy: 'release-please',
    operationId: 'rel-infradev-v0-4-0-1',
    requestedAt: '2026-10-13T00:00:00.000Z',
    ...overrides
  }
}

export { INFRA_SHA, pin, registry, registryEntry }
