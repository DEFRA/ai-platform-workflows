import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { readCommandFile } from './command-file.js'

// Git Bash on Windows, where `bash` may be WSL: set AIP_TEST_BASH.
const BASH = process.env.AIP_TEST_BASH ?? 'bash'
const SCRIPTS = resolve(import.meta.dirname, '..', '..', 'scripts')

// Records each call and prints what the scripts read from terraform; the
// saved plan is AIP_TEST_PLAN when set.
const FAKE_TERRAFORM = `#!/usr/bin/env bash
printf 'terraform %s\\n' "$*" >> "$AIP_TEST_LOG"
case "$*" in
  *"-json backend") echo '{"container_name":"tfstate","resource_group_name":"SNDAIPINFRGP1402","storage_account_name":"sndaipinfsto1401"}' ;;
  *"show -json tfplan") if [[ -n "\${AIP_TEST_PLAN:-}" ]]; then cat "$AIP_TEST_PLAN"; else echo '{"resource_changes":[]}'; fi ;;
  *"-json tfplan") echo '{"@message":"Apply complete!"}' ;;
  *"output -json") echo '{}' ;;
esac
[[ "$*" != *"\${AIP_TEST_FAIL:-none}"* ]]
`

// Records each call to the Azure CLI; a call matching AIP_TEST_FAIL fails.
const FAKE_AZ = `#!/usr/bin/env bash
printf 'az %s\\n' "$*" >> "$AIP_TEST_LOG"
[[ "$*" != *"\${AIP_TEST_FAIL:-none}"* ]]
`

// Records each call; writes the files the scripts expect from the CLI.
const FAKE_CHECKS = `const { appendFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.AIP_TEST_LOG, 'checks ' + args.join(' ') + '\\n')
const out = args[args.indexOf('--out') + 1]
if (args[0] === 'teams-variables') writeFileSync(out, '{}')
if (args[0] === 'run-report') {
  writeFileSync(out, JSON.stringify({
    outcome: args[args.indexOf('--outcome') + 1],
    changes: { total: { create: 2, update: 1, delete: 0, replace: 0 } },
    operations: [{ operationIds: ['op-00000001'] }],
    failingTeams: [],
    entraObjects: 4
  }))
}
process.exit(process.env.AIP_TEST_FAIL === args[0] ? 1 : 0)
`

// Windows jq writes CRLF unless told not to; the scripts target Linux runners.
const JQ_SHIM = `#!/usr/bin/env bash
exec jq.exe --binary "$@"
`

function posix(path) {
  return path.replaceAll('\\', '/')
}

// A PATH entry bash accepts: /c/... for C:\... in Git Bash.
function bashPath(path) {
  return posix(path).replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`
  )
}

/**
 * A workspace to run one of scripts/ in, as a workflow step would: the
 * Actions files, and fakes of terraform and the aip-checks CLI that log
 * every call to commands().
 *
 * @returns {object} The workspace.
 */
function createWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'aip-script-'))
  const bin = join(dir, 'bin')
  const files = {
    GITHUB_ENV: join(dir, 'github-env'),
    GITHUB_OUTPUT: join(dir, 'github-output'),
    GITHUB_STEP_SUMMARY: join(dir, 'github-summary'),
    AIP_TEST_LOG: join(dir, 'commands.log')
  }

  mkdirSync(bin)
  writeFileSync(join(bin, 'terraform'), FAKE_TERRAFORM)
  chmodSync(join(bin, 'terraform'), 0o755)
  writeFileSync(join(bin, 'az'), FAKE_AZ)
  chmodSync(join(bin, 'az'), 0o755)
  writeFileSync(join(dir, 'fake-checks.cjs'), FAKE_CHECKS)

  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'jq'), JQ_SHIM)
  }

  for (const path of Object.values(files)) {
    writeFileSync(path, '')
  }

  function read(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  return {
    dir,
    path: (...parts) => posix(join(dir, ...parts)),

    /**
     * Runs a script with arguments, in the workspace, with env added to the
     * step environment and the fakes first on PATH.
     *
     * @param {string} script - File name in scripts/.
     * @param {string[]} [args] - Arguments.
     * @param {Record<string, string>} [env] - Variables.
     * @returns {{status: number, stdout: string, stderr: string}} Result.
     */
    run(script, args = [], env = {}) {
      return spawnSync(
        BASH,
        [
          '-c',
          'PATH="$AIP_TEST_BIN:$PATH" exec bash "$@"',
          'bash',
          posix(join(SCRIPTS, script)),
          ...args
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(files).map(([name, path]) => [name, posix(path)])
            ),
            AIP_TEST_BIN: bashPath(bin),
            RUNNER_TEMP: posix(dir),
            AIP_CHECKS: posix(join(dir, 'fake-checks.cjs')),
            ...env
          }
        }
      )
    },
    commands: () => read(files.AIP_TEST_LOG).split('\n').filter(Boolean),
    exported: () => readCommandFile(files.GITHUB_ENV),
    outputs: () => readCommandFile(files.GITHUB_OUTPUT),
    summary: () => read(files.GITHUB_STEP_SUMMARY),
    write(path, text) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    },
    git(...args) {
      const result = spawnSync('git', ['-C', join(dir, 'state'), ...args], {
        encoding: 'utf8'
      })

      if (result.status !== 0) {
        throw new Error(result.stderr)
      }

      return result.stdout.trim()
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

export { createWorkspace, posix }
