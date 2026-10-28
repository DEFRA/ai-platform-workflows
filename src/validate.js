import {
  configDir,
  readJson,
  writeEnvironmentsConfig,
  writeSummary
} from './github.js'
import { kindOf, OutcomeError, pinnedRelease, pinPath } from './gitops.js'

const ENVIRONMENT_FOLDER = /^environments\/([a-z][a-z0-9]{1,15})\//

function changedEnvironments(files) {
  const paths = files.flatMap((file) =>
    [file.filename, file.previous_filename].filter(Boolean)
  )

  return [
    ...new Set(
      paths.map((path) => ENVIRONMENT_FOLDER.exec(path)?.[1]).filter(Boolean)
    )
  ]
}

// Reviewers whose latest approving or withdrawing review is an approval of the
// head commit. A comment-only review changes no one's vote on GitHub, so it is
// ignored (it does not withdraw an approval).
function approversOf(reviews, headSha) {
  const latest = new Map()

  for (const review of reviews) {
    if (
      review.commit_id === headSha &&
      review.user &&
      review.state !== 'COMMENTED' &&
      review.state !== 'PENDING'
    ) {
      latest.set(review.user.login, review.state)
    }
  }

  return [...latest]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login)
}

function touchesEnvironments(files) {
  return files.some((file) =>
    [file.filename, file.previous_filename]
      .filter(Boolean)
      .some((path) => path.startsWith('environments/'))
  )
}

async function approversOfHead(github, context, pull) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100
  })

  return approversOf(reviews, pull.head.sha)
}

/**
 * prepare-validation: the facts the checks need about a state repository
 * pull request. Finds the one environment it changes, resolves that
 * environment's pinned release and copies its parameters to AIP_CONFIG, and
 * exports AIP_KIND, AIP_ENVIRONMENT, AIP_RELEASE, AIP_SHA, AIP_BASE_SHA,
 * AIP_HEAD_SHA, AIP_AUTHOR, AIP_LABELS and AIP_APPROVERS.
 *
 * A pull request that changes nothing under environments/ (a change to
 * `.github/`, the README) has no environment to validate: it passes once
 * someone has approved its head, and exports AIP_SKIP_VALIDATION so the file
 * checks do not run. The ruleset's code-owner review (AC23) is what makes
 * that approval one of `aice-platform-admins` for `.github/`.
 *
 * @param {object} input - Command context from main.js; `github` reads this
 *   repository's pull request, `app` the other GitOps repositories.
 * @returns {Promise<{environment: string | null, release: string | null,
 *   outcome?: string}>} What is validated.
 */
async function prepareValidation({ github, app, context, core, env }) {
  const pull = context.payload.pull_request
  const kind = kindOf(context.repo.repo)
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100
  })

  if (!touchesEnvironments(files)) {
    const approvers = await approversOfHead(github, context, pull)

    if (approvers.length === 0) {
      throw new OutcomeError(
        'checks-failed',
        'A pull request that changes nothing under environments/ needs an approving review of its head commit.'
      )
    }

    core.exportVariable('AIP_SKIP_VALIDATION', 'true')
    await writeSummary(core, 'approved', [
      `Changes nothing under environments/, so there is no file to validate. Approved by ${approvers.map((login) => `\`${login}\``).join(', ')}.`
    ])

    return { environment: null, release: null, outcome: 'approved' }
  }

  const environments = changedEnvironments(files)

  if (environments.length !== 1) {
    throw new OutcomeError(
      'checks-failed',
      'A pull request here changes the files of exactly one environment, ' +
        `under environments/{env}/; this one changes ${environments.length}.`
    )
  }

  const [environment] = environments
  const { release, sha } = await pinnedRelease({
    github,
    app,
    context,
    kind,
    environment,
    ref: pull.base.sha,
    fallback:
      kind === 'pins'
        ? await readJson(github, {
            ...context.repo,
            path: pinPath(environment),
            ref: pull.head.sha
          })
        : null
  })
  const approvers = await approversOfHead(github, context, pull)

  await writeEnvironmentsConfig(app, {
    owner: context.repo.owner,
    environments: [environment],
    dir: configDir(env)
  })

  const facts = {
    AIP_KIND: kind,
    AIP_ENVIRONMENT: environment,
    AIP_RELEASE: release,
    AIP_SHA: sha,
    AIP_BASE_SHA: pull.base.sha,
    AIP_HEAD_SHA: pull.head.sha,
    AIP_AUTHOR: pull.user.login,
    AIP_LABELS: pull.labels.map((label) => label.name).join(','),
    AIP_APPROVERS: approvers.join(',')
  }

  for (const [name, value] of Object.entries(facts)) {
    core.exportVariable(name, value)
  }

  await writeSummary(core, `${environment} at ${release}`, [
    `Validating with ai-platform-infra \`${release}\` (\`${sha}\`).`
  ])

  return { environment, release }
}

export { prepareValidation }
