const RUN_KEY = /^(\s*)(- )?run:[ \t]*(.*)$/
const BLOCK_HEADER = /^[|>][+-]?\d*[ \t]*(#.*)?$/

function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Every `run` script in a workflow or action file, whole: an inline value, and
 * every line of a block scalar (`run: |`, `run: >-`, `- run: |` and the
 * rest), up to the first line indented no deeper than the key.
 *
 * @param {string} text - The YAML file.
 * @returns {string[]} One entry per `run`, its lines joined by newlines.
 */
function runScripts(text) {
  const lines = text.split('\n')
  const scripts = []

  for (let index = 0; index < lines.length; index++) {
    const match = RUN_KEY.exec(lines[index])

    if (!match) {
      continue
    }

    // The key sits after the `- ` of a list item, so its own column is there.
    const keyIndent = match[1].length + (match[2] ? 2 : 0)
    const body = BLOCK_HEADER.test(match[3]) ? [] : [match[3]]

    while (index + 1 < lines.length) {
      const next = lines[index + 1]

      if (next.trim() !== '' && indentOf(next) <= keyIndent) {
        break
      }

      body.push(next.trim())
      index++
    }

    scripts.push(body.join('\n'))
  }

  return scripts
}

export { runScripts }
