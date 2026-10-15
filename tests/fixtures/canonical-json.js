// The canonical serialisation of ai-platform-infra checks/src/canonical-json.js
// (keys sorted at every level, two-space indent, one trailing newline), which
// the release loads from the released checkout.

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])])
    )
  }

  return value
}

/**
 * A document's canonical text.
 *
 * @param {unknown} value - Any JSON value.
 * @returns {string} The text.
 */
function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

export { canonicalJson }
