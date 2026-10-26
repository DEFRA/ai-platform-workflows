import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// The event schema is the one the Portal API and the worker validate every
// event against (ai-platform-infra schemas/messages/event.schema.json, a
// byte-for-byte copy: set AIP_INFRA_SCHEMAS to a checkout's directory to prove
// it). It is checked with Ajv, as they check it, so every rule counts: the
// conditional ones (what an event with an operation must name, what deployed
// carries) are the ones a hand-written subset of JSON Schema once missed.
const SCHEMA_FILE = join(
  import.meta.dirname,
  '../fixtures/aip-gitops/event.schema.json'
)
const SCHEMA = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
// strictRequired is off because the schema's conditions name properties that
// they define elsewhere (a `then` that requires failureReason).
const ajv = new (Ajv2020.default ?? Ajv2020)({
  allErrors: true,
  strict: true,
  strictRequired: false
})

;(addFormats.default ?? addFormats)(ajv)

const check = ajv.compile(SCHEMA)

/**
 * What is wrong with an event, in the words of the schema.
 *
 * @param {unknown} event - An event body.
 * @returns {string[]} Problems; empty when the event is valid.
 */
function eventProblems(event) {
  return check(event)
    ? []
    : check.errors.map(
        (error) => `${error.instancePath || '/'} ${error.message}`
      )
}

export { eventProblems, SCHEMA, SCHEMA_FILE }
