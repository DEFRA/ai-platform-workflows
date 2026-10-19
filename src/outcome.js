/**
 * A failure the GitOps contract names: the outcome code is the job summary's
 * heading and the step's `outcome` output.
 */
class OutcomeError extends Error {
  /**
   * @param {string} outcome - Outcome code, for example checks-failed.
   * @param {string} message - What a person reading the run needs to know.
   */
  constructor(outcome, message) {
    super(message)
    this.name = 'OutcomeError'
    this.outcome = outcome
  }
}

export { OutcomeError }
