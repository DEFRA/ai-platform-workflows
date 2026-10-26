import { readFileSync, writeFileSync } from 'node:fs'

import { isExemptApp } from './admin.js'
import { writeSummary } from './github.js'
import { OutcomeError } from './outcome.js'

/**
 * Whether the environment's pause holds a run back: AIP_PAUSED is `true` and
 * an exempt App dispatched it (a retry, a reconcile or a resubmission). Push
 * and schedule runs and an admin's hand run go through (§5 Pause).
 *
 * @param {{paused: string, eventName: string, actor: string}} run - Facts.
 * @returns {boolean} True when the run must change nothing.
 */
function heldBack({ paused, eventName, actor }) {
  return (
    paused === 'true' && eventName === 'workflow_dispatch' && isExemptApp(actor)
  )
}

/**
 * pause-gate: the apply's first job, which runs in the `{env}-events`
 * Environment because only that one holds AIP_PAUSED. Records whether this
 * run is held back in AIP_HELD_FILE, for the apply job to read.
 *
 * Inputs: AIP_PAUSED, AIP_ACTOR, AIP_HELD_FILE.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{held: boolean}>} The decision.
 */
async function pauseGate({ context, core, env }) {
  const held = heldBack({
    paused: env.AIP_PAUSED,
    eventName: context.eventName,
    actor: env.AIP_ACTOR || context.actor
  })

  writeFileSync(env.AIP_HELD_FILE, `${held}\n`)
  await writeSummary(core, held ? 'paused' : 'not paused', [
    `${env.AIP_ENVIRONMENT} is ${env.AIP_PAUSED === 'true' ? '' : 'not '}paused.`
  ])

  return { held }
}

/**
 * held: reads what pause-gate recorded and exports AIP_HELD for the steps
 * that follow. A missing record fails closed, so a lost gate never lets a
 * held run apply.
 *
 * Inputs: AIP_HELD_FILE.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{held: boolean}>} The decision.
 */
async function held({ core, env }) {
  let text

  try {
    text = readFileSync(env.AIP_HELD_FILE, 'utf8').trim()
  } catch {
    throw new OutcomeError('failed', 'the pause check left no record')
  }

  if (text !== 'true' && text !== 'false') {
    throw new OutcomeError('failed', 'the pause check left no record')
  }

  core.exportVariable('AIP_HELD', text)

  return { held: text === 'true' }
}

export { held, heldBack, pauseGate }
