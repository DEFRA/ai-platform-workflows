import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')

function lines(file) {
  return readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
}

describe('files that release-please writes', () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')
  )
  const written = [
    config.packages['.']['changelog-path'],
    '.release-please-manifest.json'
  ]

  test.each(written)(
    '%s is ignored by prettier, so a release pull request passes lint',
    (file) => {
      expect(lines('.prettierignore')).toContain(file)
    }
  )
})
