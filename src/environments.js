import {
  changedPaths,
  dispatchWorkflow,
  gitopsRepo,
  readFile,
  readJson,
  tagCommit,
  writeSummary
} from './github.js'
import { pinPath } from './gitops.js'

// Files every environment's apply reads.
const SHARED_FILES = new Set(['registry.json', 'global.tfvars.json'])
const NO_COMMIT = /^0{40}$/

/**
 * latest-release: the newest ai-platform-infra release, which validates the
 * configuration in ai-platform-environments. Exports AIP_RELEASE and AIP_SHA.
 *
 * @param {object} input - Command context from main.js.
 * @returns {Promise<{release: string, sha: string}>} The release.
 */
async function latestRelease({ github, context, core }) {
  const infra = gitopsRepo(context.repo.owner, 'infra')
  const { data } = await github.rest.repos.getLatestRelease(infra)
  const sha = await tagCommit(github, { ...infra, tag: data.tag_name })

  core.exportVariable('AIP_RELEASE', data.tag_name)
  core.exportVariable('AIP_SHA', sha)

  return { release: data.tag_name, sha }
}

/**
 * dispatch-changed-environments: after a merge to main of
 * ai-platform-environments, dispatches the platform apply for each
 * environment whose parameters changed, or for every environment when a
 * shared file changed. An environment without a pin is skipped: its first
 * pin applies its parameters.
 *
 * @param {object} input - Command context from main.js; `github` reads this
 *   repository, `app` dispatches in ai-platform-deployments.
 * @returns {Promise<{dispatched: string[]}>} The environments dispatched.
 */
async function dispatchChangedEnvironments({ github, app, context, core }) {
  const { owner, repo } = context.repo
  const before = context.payload.before ?? ''
  const registry = await readJson(github, {
    owner,
    repo,
    path: 'registry.json',
    ref: context.sha
  })
  const paths = NO_COMMIT.test(before)
    ? null
    : await changedPaths(github, {
        owner,
        repo,
        base: before,
        head: context.sha
      })
  const shared = paths === null || paths.some((path) => SHARED_FILES.has(path))
  const changed = registry.environments
    .map((entry) => entry.name)
    .filter(
      (name) =>
        shared || paths.some((path) => path.startsWith(`environments/${name}/`))
    )
  const deployments = gitopsRepo(owner, 'deployments')
  const dispatched = []
  const lines = []

  for (const environment of changed) {
    const pin = await readFile(app, {
      ...deployments,
      path: pinPath(environment),
      ref: 'main'
    })

    if (pin === null) {
      lines.push(`- \`${environment}\`: no pin yet; its first pin applies it`)
      continue
    }

    const url = await dispatchWorkflow(app, {
      ...deployments,
      workflow: 'apply.yml',
      inputs: {
        environment,
        reason: `parameters changed in ${context.sha.slice(0, 7)}`
      }
    })
    dispatched.push(environment)
    lines.push(`- \`${environment}\`: ${url ?? 'started'}`)
  }

  await writeSummary(
    core,
    'Platform applies dispatched',
    lines.length > 0 ? lines : ['No environment changed.']
  )

  return { dispatched }
}

export { dispatchChangedEnvironments, latestRelease }
