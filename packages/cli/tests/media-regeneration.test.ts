import { describe, expect, it } from 'vitest'
import { createInternalCommands } from '../src/cli'
import { parseTokens } from '../src/parsing'

const root = '/tmp/holo-media-regenerate'

describe('media:regenerate command', () => {
  it('accepts repeated and comma-separated filters and rejects malformed media IDs', async () => {
    const context = {
      cwd: root, projectRoot: root, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
      registry: [], loadProject: async () => { throw new Error('Project loading is not needed for preparation') },
    }
    const command = createInternalCommands(context).find(command => command.name === 'media:regenerate')
    if (!command?.prepare) throw new Error('Missing media regeneration command')
    expect(await command.prepare(parseTokens(['Post', 'Product', '--ids=1,2', '--ids=3', '--only=thumb,card', '--only-missing']), context)).toEqual({
      args: ['Post', 'Product'], flags: { ids: ['1', '2', '3'], only: ['thumb', 'card'], 'only-missing': true },
    })
    for (const flag of ['--ids=abc', '--ids=-1', '--ids=1.5', '--ids=', '--ids', '--only=']) {
      await expect(command.prepare(parseTokens([flag]), context)).rejects.toThrow()
    }
  })
})
