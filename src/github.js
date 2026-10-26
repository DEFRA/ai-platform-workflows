import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { OutcomeError } from './outcome.js'

// The REST API version the GitOps contract is written against; with it a
// workflow dispatch returns the run it started.
const API_VERSION = '2026-03-10'
// GitHub marks an earlier successful deployment `inactive` once a later one
// for the same environment succeeds, so `inactive` was a success too.
const SUCCEEDED_DEPLOYMENT_STATES = new Set(['success', 'inactive'])
const RECENT_DEPLOYMENTS = 30
// A comparison lists at most 300 changed files.
const COMPARE_FILE_LIMIT = 300
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/

/**
 * Sends every request of a client with the contract's API version.
 *
 * @param {object} octokit - An Octokit client.
 * @returns {object} The same client.
 */
function withApiVersion(octokit) {
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = API_VERSION
  })

  return octokit
}

/**
 * The GitOps repository `ai-platform-{name}` of an owner.
 *
 * @param {string} owner - Organisation or user.
 * @param {string} name - infra, environments, tenants or deployments.
 * @returns {{owner: string, repo: string}} Repository coordinates.
 */
function gitopsRepo(owner, name) {
  return { owner, repo: `ai-platform-${name}` }
}

/**
 * A file's text and blob SHA at a ref. The blob SHA is the base a write to a
 * pin names (`expected_base`).
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, path: string, ref: string}} file
 * @returns {Promise<{text: string, sha: string} | null>} Null when there is
 *   no file.
 */
async function readBlob(octokit, { owner, repo, path, ref }) {
  const response = await unless404(
    octokit.rest.repos.getContent({ owner, repo, path, ref })
  )

  return (
    response && {
      text: Buffer.from(response.data.content, response.data.encoding).toString(
        'utf8'
      ),
      sha: response.data.sha
    }
  )
}

/**
 * A file's text at a ref.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, path: string, ref: string}} file
 * @returns {Promise<string | null>} The text, or null when there is no file.
 */
async function readFile(octokit, file) {
  return (await readBlob(octokit, file))?.text ?? null
}

/**
 * A JSON file at a ref.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, path: string, ref: string}} file
 * @returns {Promise<object | null>} The document, or null when there is none.
 */
async function readJson(octokit, file) {
  const text = await readFile(octokit, file)

  return text === null ? null : JSON.parse(text)
}

/**
 * Whether a folder holds anything at a ref.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, path: string, ref: string}} folder
 * @returns {Promise<boolean>} True when the folder exists.
 */
async function folderExists(octokit, { owner, repo, path, ref }) {
  const response = await unless404(
    octokit.rest.repos.getContent({ owner, repo, path, ref })
  )

  return response !== null
}

async function unless404(request) {
  try {
    return await request
  } catch (error) {
    if (error.status === 404) {
      return null
    }

    throw error
  }
}

/**
 * The commit of the newest successful GitHub Deployment for an environment.
 *
 * @param {object} octokit - Client with deployments read.
 * @param {{owner: string, repo: string, environment: string}} target
 * @returns {Promise<string | null>} The commit SHA, or null before the first.
 */
async function lastApplied(octokit, { owner, repo, environment }) {
  const { data: deployments } = await octokit.rest.repos.listDeployments({
    owner,
    repo,
    environment,
    per_page: RECENT_DEPLOYMENTS
  })

  for (const deployment of deployments) {
    // A job on `{env}-events` records Deployments of its own (the pause gate
    // and the events identity); only the Environment's own count here.
    if (deployment.environment && deployment.environment !== environment) {
      continue
    }

    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: deployment.id,
      per_page: 1
    })

    if (SUCCEEDED_DEPLOYMENT_STATES.has(statuses[0]?.state)) {
      return deployment.sha
    }
  }

  return null
}

/**
 * The newest deployment to an environment, and whether it succeeded, so a
 * later failure is never hidden behind an earlier success at the same
 * commit (a parameters change re-applies the same commit).
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, environment: string}} target
 * @returns {Promise<{sha: string, succeeded: boolean} | null>} Null before
 *   the first deployment.
 */
async function latestDeployment(octokit, { owner, repo, environment }) {
  const { data: deployments } = await octokit.rest.repos.listDeployments({
    owner,
    repo,
    environment,
    per_page: 1
  })
  const deployment = deployments[0]

  if (!deployment) {
    return null
  }

  const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
    owner,
    repo,
    deployment_id: deployment.id,
    per_page: 1
  })

  return {
    sha: deployment.sha,
    succeeded: SUCCEEDED_DEPLOYMENT_STATES.has(statuses[0]?.state)
  }
}

/**
 * The commit at the head of main.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string}} repository
 * @returns {Promise<string>} The commit SHA.
 */
async function headOfMain(octokit, { owner, repo }) {
  const { data } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: 'heads/main'
  })

  return data.object.sha
}

/**
 * The paths changed between two commits, renames counted at both ends.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, base: string, head: string}} range
 * @returns {Promise<string[] | null>} Paths, or null when there are too many
 *   to list and every path must be treated as changed.
 */
async function changedPaths(octokit, { owner, repo, base, head }) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
    per_page: 1
  })
  const files = data.files ?? []

  if (files.length >= COMPARE_FILE_LIMIT) {
    return null
  }

  return files.flatMap((file) =>
    [file.filename, file.previous_filename].filter(Boolean)
  )
}

/**
 * Whether a commit is the base commit or one of its descendants.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, base: string, head: string}} range
 * @returns {Promise<boolean>} True when head includes base.
 */
async function includesCommit(octokit, { owner, repo, base, head }) {
  if (base === head) {
    return true
  }

  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
    per_page: 1
  })

  return data.status === 'ahead' || data.status === 'identical'
}

/**
 * The commit a tag points to, through an annotated tag object if there is one.
 *
 * @param {object} octokit - Client that can read the repository.
 * @param {{owner: string, repo: string, tag: string}} tag
 * @returns {Promise<string>} The commit SHA.
 */
async function tagCommit(octokit, { owner, repo, tag }) {
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `tags/${tag}`
  })

  if (ref.object.type !== 'tag') {
    return ref.object.sha
  }

  const { data: annotated } = await octokit.rest.git.getTag({
    owner,
    repo,
    tag_sha: ref.object.sha
  })

  return annotated.object.sha
}

/**
 * Proves a pin's release is the commit it names in ai-platform-infra: a tag
 * must resolve to the SHA, and a SHA pin repeats the SHA as its release.
 *
 * @param {object} octokit - Client that can read ai-platform-infra.
 * @param {string} owner - Organisation of the GitOps repositories.
 * @param {{release: string, sha: string}} pin - The pin.
 * @returns {Promise<void>} Resolves when the pin is consistent.
 */
async function verifyRelease(octokit, owner, { release, sha }) {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`the pin's sha ${sha} is not a commit SHA`)
  }

  if (COMMIT_SHA.test(release)) {
    if (release !== sha) {
      throw new Error('a SHA pin repeats its sha as the release')
    }

    return
  }

  if (!RELEASE_TAG.test(release)) {
    throw new Error(`the pin's release ${release} is not a tag vX.Y.Z or SHA`)
  }

  const tagged = await tagCommit(octokit, {
    ...gitopsRepo(owner, 'infra'),
    tag: release
  })

  if (tagged !== sha) {
    throw new Error(`${release} resolves to ${tagged}, not the pinned ${sha}`)
  }
}

/**
 * Starts a workflow on main. A disabled workflow is an engineer's pause, so
 * the dispatch fails with the outcome `workflow-disabled` rather than
 * re-enabling it; the Actions tab of the target repository turns it back on.
 *
 * @param {object} octokit - Client with actions write on the repository.
 * @param {{owner: string, repo: string, workflow: string, inputs: object}} run
 * @returns {Promise<string | null>} The started run's URL.
 */
async function dispatchWorkflow(octokit, { owner, repo, workflow, inputs }) {
  try {
    const { data } = await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflow,
      ref: 'main',
      inputs
    })

    return data?.html_url ?? null
  } catch (error) {
    if (error.status === 422 && /disabled workflow/i.test(error.message)) {
      throw new OutcomeError(
        'workflow-disabled',
        `${owner}/${repo} ${workflow} is disabled; enable it in that repository's Actions tab, then dispatch again`
      )
    }

    throw error
  }
}

/**
 * Copies the shared parameters, the registry and each environment's
 * parameters from main of ai-platform-environments into a folder laid out
 * like that repository, for the checks and Terraform.
 *
 * @param {object} octokit - Client that can read ai-platform-environments.
 * @param {{owner: string, environments: string[], dir: string}} input
 * @returns {Promise<void>} Resolves when every file is written.
 */
async function writeEnvironmentsConfig(octokit, { owner, environments, dir }) {
  const repository = gitopsRepo(owner, 'environments')
  const paths = [
    'registry.json',
    'global.tfvars.json',
    ...environments.map((name) => `environments/${name}/platform.tfvars.json`)
  ]

  for (const path of paths) {
    const text = await readFile(octokit, { ...repository, path, ref: 'main' })

    if (text === null) {
      throw new Error(`ai-platform-environments has no ${path}`)
    }

    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
}

/**
 * Appends a heading and lines to the job summary.
 *
 * @param {object} core - The Actions toolkit core module.
 * @param {string} heading - Usually an outcome code.
 * @param {string[]} [lines] - Markdown lines.
 * @returns {Promise<void>} Resolves when written.
 */
async function writeSummary(core, heading, lines = []) {
  await core.summary
    .addRaw(`### ${heading}\n\n${lines.join('\n')}`, true)
    .write()
}

export {
  API_VERSION,
  changedPaths,
  dispatchWorkflow,
  folderExists,
  gitopsRepo,
  headOfMain,
  includesCommit,
  lastApplied,
  latestDeployment,
  readBlob,
  readFile,
  readJson,
  tagCommit,
  verifyRelease,
  withApiVersion,
  writeEnvironmentsConfig,
  writeSummary
}
