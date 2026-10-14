// Response bodies of the GitHub REST API, reduced to the fields the GitOps
// modules read. Shapes from the REST reference for API version 2026-03-10
// (docs.github.com/rest, read 14 October 2026): repos/contents, git/refs,
// git/tags, git/commits, repos/deployments, repos/commits (compare),
// pulls, pulls/reviews, releases, checks/runs, repos/rules and
// actions/workflows (dispatch).

const SHA = 'a'.repeat(40)

/**
 * GET /repos/{owner}/{repo}/contents/{path} for a file.
 *
 * @param {string | object} value - The text, or a document to serialise.
 * @returns {object} The content object.
 */
function fileContent(value) {
  const text =
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`

  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text).toString('base64')
  }
}

/**
 * GET /repos/{owner}/{repo}/contents/{path} for a folder.
 *
 * @returns {object[]} The folder's entries.
 */
function folderContent() {
  return [{ type: 'file', name: 'alpha.json' }]
}

/**
 * GET /repos/{owner}/{repo}/git/ref/{ref}.
 *
 * @param {string} sha - The object it points to.
 * @param {'commit' | 'tag'} [type] - A commit, or an annotated tag object.
 * @returns {object} The reference.
 */
function gitRef(sha, type = 'commit') {
  return { ref: 'refs/heads/main', object: { sha, type } }
}

/**
 * GET /repos/{owner}/{repo}/git/tags/{tag_sha}.
 *
 * @param {string} commitSha - The commit the tag points to.
 * @returns {object} The annotated tag.
 */
function annotatedTag(commitSha) {
  return { object: { sha: commitSha, type: 'commit' } }
}

/**
 * One item of GET /repos/{owner}/{repo}/deployments.
 *
 * @param {number} id - Deployment ID.
 * @param {string} sha - Deployed commit.
 * @returns {object} The deployment.
 */
function deployment(id, sha) {
  return { id, sha, environment: 'infradev' }
}

/**
 * GET /repos/{owner}/{repo}/deployments/{id}/statuses with one status.
 *
 * @param {string} state - success, inactive, failure, error, in_progress.
 * @returns {object[]} The statuses, newest first.
 */
function deploymentStatuses(state) {
  return [{ state }]
}

/**
 * GET /repos/{owner}/{repo}/compare/{basehead}.
 *
 * @param {object} [comparison] - Status and changed paths.
 * @returns {object} The comparison.
 */
function comparison({ status = 'ahead', files = [] } = {}) {
  return {
    status,
    files: files.map((filename) =>
      typeof filename === 'string' ? { filename } : filename
    )
  }
}

/**
 * A pull request from GET or POST /repos/{owner}/{repo}/pulls.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The pull request.
 */
function pullRequest(overrides = {}) {
  return {
    number: 7,
    node_id: 'PR_kwDOAAAAAA',
    html_url: 'https://github.com/DEFRA/ai-platform-tenants/pull/7',
    state: 'open',
    merged_at: null,
    user: { login: 'ai-platform-orchestrator[bot]', type: 'Bot' },
    labels: [{ name: 'gitops' }, { name: 'env:infradev' }],
    head: { ref: 'op/000000000000000000000001', sha: 'b'.repeat(40) },
    base: { ref: 'main', sha: SHA },
    ...overrides
  }
}

/**
 * One item of GET /repos/{owner}/{repo}/pulls/{n}/files.
 *
 * @param {string} filename - Repository-relative path.
 * @param {string} [previousFilename] - The path before a rename.
 * @returns {object} The file.
 */
function pullRequestFile(filename, previousFilename) {
  return {
    filename,
    status: previousFilename ? 'renamed' : 'modified',
    ...(previousFilename && { previous_filename: previousFilename })
  }
}

/**
 * One item of GET /repos/{owner}/{repo}/pulls/{n}/reviews.
 *
 * @param {string} login - Reviewer.
 * @param {string} state - APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED.
 * @param {string} commitId - The commit reviewed.
 * @returns {object} The review.
 */
function review(login, state, commitId) {
  return { user: { login }, state, commit_id: commitId }
}

/**
 * GET /repos/{owner}/{repo}/releases/latest.
 *
 * @param {string} tag - Tag name.
 * @returns {object} The release.
 */
function release(tag) {
  return { tag_name: tag, draft: false, prerelease: false }
}

/**
 * GET /repos/{owner}/{repo}/commits/{ref}/check-runs.
 *
 * @param {Array<[string, string, string | null]>} runs - Name, status and
 *   conclusion of each check run.
 * @returns {object} The check runs.
 */
function checkRuns(runs) {
  return {
    total_count: runs.length,
    check_runs: runs.map(([name, status, conclusion]) => ({
      name,
      status,
      conclusion
    }))
  }
}

/**
 * GET /repos/{owner}/{repo}/rules/branches/{branch} with a required status
 * checks rule.
 *
 * @param {string[]} contexts - The required checks.
 * @returns {object[]} The active rules.
 */
function branchRules(contexts) {
  return [
    { type: 'pull_request', parameters: {} },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: contexts.map((context) => ({ context }))
      }
    }
  ]
}

/**
 * One item of GET /repos/{owner}/{repo}/git/matching-refs/{ref}.
 *
 * @param {string} branch - Branch name.
 * @param {string} sha - Head commit.
 * @returns {object} The reference.
 */
function matchingRef(branch, sha) {
  return { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }
}

/**
 * GET /repos/{owner}/{repo}/git/commits/{sha}.
 *
 * @param {string} date - Committer date, ISO 8601.
 * @returns {object} The commit.
 */
function gitCommit(date) {
  return { committer: { date } }
}

/**
 * POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches, which
 * returns the run it started with this API version.
 *
 * @param {number} runId - The run.
 * @param {string} [repo] - Repository name.
 * @returns {object} The started run.
 */
function dispatchedRun(runId, repo = 'ai-platform-tenants') {
  return {
    workflow_run_id: runId,
    run_url: `https://api.github.com/repos/DEFRA/${repo}/actions/runs/${runId}`,
    html_url: `https://github.com/DEFRA/${repo}/actions/runs/${runId}`
  }
}

export {
  annotatedTag,
  branchRules,
  checkRuns,
  comparison,
  deployment,
  deploymentStatuses,
  dispatchedRun,
  fileContent,
  folderContent,
  gitCommit,
  gitRef,
  matchingRef,
  pullRequest,
  pullRequestFile,
  release,
  review
}
