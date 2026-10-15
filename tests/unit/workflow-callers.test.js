import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = join(import.meta.dirname, '../../.github/workflows')
const KEY = 'secrets.GITOPS_APP_PRIVATE_KEY'
const LOCAL_CALL = /^ {4}uses: \.\/\.github\/workflows\/(.+\.yml)$/

function read(file) {
  return readFileSync(join(WORKFLOWS, file), 'utf8')
}

function localCalls() {
  const calls = []

  for (const file of readdirSync(WORKFLOWS)) {
    const lines = read(file).split('\n')

    lines.forEach((line, index) => {
      const target = LOCAL_CALL.exec(line)?.[1]

      if (target) {
        const end = lines.findIndex(
          (next, i) => i > index && /^ {0,2}\S/.test(next)
        )
        const job = lines.slice(index, end === -1 ? undefined : end).join('\n')

        calls.push({ file, target, job })
      }
    })
  }

  return calls
}

describe('callers of workflows that mint an App token', () => {
  const calls = localCalls().filter(({ target }) => read(target).includes(KEY))

  test('this repository calls at least one', () => {
    expect(calls.length).toBeGreaterThan(0)
  })

  test.each(calls)('$file passes secrets to $target', ({ job }) => {
    expect(job).toContain('secrets: inherit')
  })
})

describe('reusable workflows', () => {
  const reusable = readdirSync(WORKFLOWS).filter((file) =>
    read(file).includes('  workflow_call:')
  )

  test.each(reusable.filter((file) => read(file).includes(KEY)))(
    '%s declares the App key as a required secret',
    (file) => {
      expect(read(file)).toMatch(
        /^ {4}secrets:\n {6}GITOPS_APP_PRIVATE_KEY:\n(?: {8}.+\n)* {8}required: true$/m
      )
    }
  )

  test.each(reusable)(
    '%s uses only a real environment as a GitHub Environment',
    (file) => {
      const names = [
        ...read(file).matchAll(/^ {4}environment:\n {6}name: (.+)$/gm)
      ]

      expect(names.map(([, name]) => name)).toSatisfy((all) =>
        all.every((name) => name.startsWith('${{'))
      )
    }
  )
})
