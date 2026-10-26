import { adminCheck } from './admin.js'
import { dispatchApply, preflight, resolveApply } from './apply.js'
import { dispatchChangedEnvironments, latestRelease } from './environments.js'
import { buildEvent } from './events.js'
import { withApiVersion, writeSummary } from './github.js'
import { OutcomeError } from './gitops.js'
import {
  mergeRelease,
  moveMajorTag,
  resolveRelease,
  submitAutoPins
} from './release.js'
import { held, endHeld, pauseGate } from './pause.js'
import { prepareSubmit, submit } from './submit.js'
import { prepareValidation } from './validate.js'

const COMMANDS = {
  'admin-check': adminCheck,
  'build-event': buildEvent,
  'dispatch-apply': dispatchApply,
  'dispatch-changed-environments': dispatchChangedEnvironments,
  'end-held': endHeld,
  held,
  'latest-release': latestRelease,
  'merge-release': mergeRelease,
  'move-major-tag': moveMajorTag,
  'pause-gate': pauseGate,
  preflight,
  'prepare-submit': prepareSubmit,
  'prepare-validation': prepareValidation,
  'resolve-apply': resolveApply,
  'resolve-release': resolveRelease,
  submit,
  'submit-auto-pins': submitAutoPins
}

/**
 * Runs the GitOps command named by GITOPS_COMMAND inside
 * actions/github-script. Both clients send the contract's API version; the
 * second, `app`, exists when GITOPS_APP_TOKEN holds an App installation token
 * for the other GitOps repositories. A failure the contract names writes its
 * outcome code to the job summary and the `outcome` output, exports it as
 * AIP_FAILURE_CODE and AIP_FAILURE_MESSAGE, and fails the step.
 *
 * @param {object} input - What github-script injects.
 * @param {object} input.github - Octokit authenticated with the step's token.
 * @param {object} input.context - The workflow run context.
 * @param {object} input.core - The Actions toolkit core module.
 * @param {(token: string) => object} input.getOctokit - Client factory.
 * @param {NodeJS.ProcessEnv} [input.env] - Parameters, AIP_* and GITOPS_*.
 * @returns {Promise<object>} The command's result: the step's `result` output.
 */
async function run({ github, context, core, getOctokit, env = process.env }) {
  const command = COMMANDS[env.GITOPS_COMMAND]

  if (!command) {
    throw new Error(`unknown GitOps command ${env.GITOPS_COMMAND}`)
  }

  const app = env.GITOPS_APP_TOKEN
    ? withApiVersion(getOctokit(env.GITOPS_APP_TOKEN))
    : null

  try {
    const result = await command({
      github: withApiVersion(github),
      app,
      context,
      core,
      env
    })

    if (result?.outcome) {
      core.setOutput('outcome', result.outcome)
    }

    return result
  } catch (error) {
    const outcome = error instanceof OutcomeError ? error.outcome : 'failed'

    core.setOutput('outcome', outcome)
    await writeSummary(core, outcome, [error.message])

    if (!(error instanceof OutcomeError)) {
      throw error
    }

    // For the step that reports the refusal as an event (publish-event).
    core.exportVariable('AIP_FAILURE_CODE', outcome)
    core.exportVariable('AIP_FAILURE_MESSAGE', error.message)
    core.setFailed(error.message)

    return { outcome }
  }
}

export { COMMANDS, run }
