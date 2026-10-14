import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { context as runnerContext } from '@actions/github'
import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'

import { readCommandFile } from './command-file.js'

// The real Context class github-script injects; it reads the run from the
// same variables the runner sets.
const Context = runnerContext.constructor
const API = 'https://api.github.com'
const OWNER = 'DEFRA'
const SHA = 'a'.repeat(40)

/**
 * An authenticated Octokit with the REST endpoint methods and pagination
 * that github-script's `github` and `getOctokit` clients have.
 *
 * @param {string} [token] - Token, sent as the Authorization header.
 * @returns {Octokit} A client.
 */
function createOctokit(token = 'github-token') {
  return new Octokit({ auth: token })
}

/**
 * The run context of a workflow in one of the GitOps repositories.
 *
 * @param {object} [run] - Run facts.
 * @param {string} [run.repo] - Repository name.
 * @param {string} [run.sha] - The run's commit.
 * @param {string} [run.eventName] - Triggering event.
 * @param {object} [run.payload] - Event payload.
 * @param {number} [run.runId] - Run ID.
 * @returns {object} A Context.
 */
function createContext({
  repo = 'ai-platform-tenants',
  sha = SHA,
  eventName = 'workflow_dispatch',
  payload = {},
  runId = 4242
} = {}) {
  const eventPath = join(process.env.RUNNER_TEMP, 'event.json')
  writeFileSync(eventPath, JSON.stringify(payload))
  vi.stubEnv('GITHUB_REPOSITORY', `${OWNER}/${repo}`)
  vi.stubEnv('GITHUB_SHA', sha)
  vi.stubEnv('GITHUB_EVENT_NAME', eventName)
  vi.stubEnv('GITHUB_EVENT_PATH', eventPath)
  vi.stubEnv('GITHUB_RUN_ID', String(runId))

  return new Context()
}

/**
 * Everything main.js passes a command, with real clients and toolkit.
 *
 * @param {object} [overrides] - Fields to replace, for example env.
 * @param {object} [run] - For createContext.
 * @returns {object} Command input.
 */
function commandInput(overrides = {}, run = {}) {
  return {
    github: createOctokit(),
    app: createOctokit('app-token'),
    context: createContext(run),
    core,
    env: {},
    ...overrides
  }
}

function stepOutputs() {
  return readCommandFile(process.env.GITHUB_OUTPUT)
}

function exportedVariables() {
  return readCommandFile(process.env.GITHUB_ENV)
}

function jobSummary() {
  return readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8')
}

export {
  API,
  commandInput,
  createContext,
  createOctokit,
  exportedVariables,
  jobSummary,
  OWNER,
  SHA,
  stepOutputs
}
