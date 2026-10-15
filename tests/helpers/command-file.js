import { readFileSync } from 'node:fs'

/**
 * The name=value pairs in an Actions file command file (GITHUB_OUTPUT,
 * GITHUB_ENV), in either the heredoc form @actions/core writes or the
 * one-line form scripts write.
 *
 * @param {string} path - The file.
 * @returns {Record<string, string>} Values by name.
 */
function readCommandFile(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const values = {}

  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[index])

    if (heredoc) {
      const [, name, delimiter] = heredoc
      const value = []

      while (lines[++index] !== delimiter) {
        value.push(lines[index])
      }

      values[name] = value.join('\n')
    } else if (lines[index].includes('=')) {
      const at = lines[index].indexOf('=')
      values[lines[index].slice(0, at)] = lines[index].slice(at + 1)
    }
  }

  return values
}

export { readCommandFile }
