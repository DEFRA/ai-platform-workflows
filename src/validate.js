import { readJson, writeEnvironmentsConfig, writeSummary } from './github.js'
import { kindOf, OutcomeError, pinnedRelease, pinPath } from './gitops.js'

const ENVIRONMENT_FOLDER = /^environments\/([a-z][a-z0-9]{1,15})\//
const OPERATION_BRANCH = /^op\/([a-z0-9][a-z0-9-]{7,63})$/

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

// Reviewers whose latest review approves the head commit.
function approversOf(reviews, headSha) {
  const latest = new Map()

  for (const review of reviews) {
    if (review.commit_id === headSha && review.user) {
      latest.set(review.user.login, review.state)
    }
  }

  return [...latest]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login)
}

/**
 * prepare-validation: the facts the checks need about a state repository
 * pull request. Finds the one environment it changes, resolves that
 * environment's pinned release and copies its parameters to AIP_CONFIG, and
 * exports AIP_KIND, AIP_ENVIRONMENT, AIP_RELEASE, AIP_SHA, AIP_BASE_SHA,
 * AIP_HEAD_SHA, AIP_AUTHOR, AIP_LABELS, AIP_APPROVERS and AIP_OPERATION_ID.
 *
 * @param {object} input - Command context from main.js; `github` reads this
 *   repository's pull request, `app` the other GitOps repositories.
 * @returns {Promise<{environment: string, release: string}>} What is validated.
 */
async function prepareValidation({ github, app, context, core, env }) {
  const pull = context.payload.pull_request
  const kind = kindOf(context.repo.repo)
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100
  })
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
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: pull.number,
    per_page: 100
  })

  await writeEnvironmentsConfig(app, {
    owner: context.repo.owner,
    environments: [environment],
    dir: env.AIP_CONFIG || 'config'
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
    AIP_APPROVERS: approversOf(reviews, pull.head.sha).join(','),
    AIP_OPERATION_ID: OPERATION_BRANCH.exec(pull.head.ref)?.[1] ?? ''
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
