import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as core from '@actions/core'
import nock from 'nock'

import { readCommandFile } from './command-file.js'

// The files the Actions runner reads step outputs, exported variables and
// the job summary from, one set per test worker.
const dir = mkdtempSync(join(tmpdir(), 'aip-actions-'))
const FILES = {
  GITHUB_OUTPUT: join(dir, 'output'),
  GITHUB_ENV: join(dir, 'env'),
  GITHUB_STEP_SUMMARY: join(dir, 'summary')
}
const saved = {}

beforeAll(() => {
  for (const name of [...Object.keys(FILES), 'RUNNER_TEMP']) {
    saved[name] = process.env[name]
  }

  Object.assign(process.env, FILES, { RUNNER_TEMP: dir })
  nock.disableNetConnect()
})

beforeEach(() => {
  for (const path of Object.values(FILES)) {
    writeFileSync(path, '')
  }

  core.summary.emptyBuffer()
})

afterEach(() => {
  // core.exportVariable also sets process.env.
  for (const name of Object.keys(readCommandFile(FILES.GITHUB_ENV))) {
    delete process.env[name]
  }

  // core.setFailed sets the exit code of the test worker.
  process.exitCode = undefined
  nock.cleanAll()
  vi.unstubAllEnvs()
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }

  nock.enableNetConnect()
  rmSync(dir, { recursive: true, force: true })
})
