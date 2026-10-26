// The small subset of JSON Schema 2020-12 the message schemas use: const,
// enum, type (one or several), pattern, length bounds, required, properties,
// additionalProperties: false and items. Enough to check what publish-event
// builds without a validator dependency (npm audit stays as it was).

function typeOf(value) {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  return Number.isInteger(value) ? 'integer' : typeof value
}

function matchesType(value, type) {
  const actual = typeOf(value)

  return actual === type || (type === 'number' && actual === 'integer')
}

function checkScalar(schema, value, where, problems) {
  if ('const' in schema && value !== schema.const) {
    problems.push(`${where} must be ${schema.const}`)
  }

  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${where} must be one of ${schema.enum.join(', ')}`)
  }

  if (typeof value !== 'string') {
    return
  }

  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${where} must match ${schema.pattern}`)
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    problems.push(`${where} is shorter than ${schema.minLength}`)
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    problems.push(`${where} is longer than ${schema.maxLength}`)
  }
}

/**
 * Validates a value against a schema.
 *
 * @param {object} schema - The schema.
 * @param {unknown} value - The value.
 * @param {string} [where] - Path of the value, for messages.
 * @returns {string[]} What is wrong; empty when the value is valid.
 */
function validate(schema, value, where = '$') {
  const problems = []

  if (schema.type) {
    const types = [schema.type].flat()

    if (!types.some((type) => matchesType(value, type))) {
      return [`${where} must be ${types.join(' or ')}`]
    }
  }

  checkScalar(schema, value, where, problems)

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      problems.push(...validate(schema.items, item, `${where}[${index}]`))
    )
  }

  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? []) {
      if (!(name in value)) {
        problems.push(`${where}.${name} is required`)
      }
    }

    for (const [name, item] of Object.entries(value)) {
      const property = schema.properties?.[name]

      if (property) {
        problems.push(...validate(property, item, `${where}.${name}`))
      } else if (schema.additionalProperties === false) {
        problems.push(`${where}.${name} is not allowed`)
      }
    }
  }

  return problems
}

export { validate }
