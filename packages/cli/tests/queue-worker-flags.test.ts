import { describe, expect, it } from 'vitest'
import { createInternalCommands } from '../src/cli'
import { buildQueueWorkArgs } from '../src/queue'
import { parseBackoffFlag } from '../src/parsing'
import type { CommandDefinition, InternalCommandContext, IoStreams } from '../src/cli-types'
import type { QueueWorkerRunOptions } from '@holo-js/queue'

function createIo(): IoStreams {
  const write = () => true
  return {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: { write } as unknown as NodeJS.WriteStream,
    stderr: { write } as unknown as NodeJS.WriteStream,
  }
}

function findQueueWorkCommand(commands: readonly CommandDefinition[]): CommandDefinition {
  const command = commands.find(entry => entry.name === 'queue:work')
  if (!command) throw new Error('queue:work is not registered.')
  return command
}

describe('queue:work --backoff', () => {
  it('parses one retry delay or a comma-separated list of retry delays', () => {
    expect(parseBackoffFlag({ backoff: '5' })).toBe(5)
    expect(parseBackoffFlag({ backoff: '5, 10,30' })).toEqual([5, 10, 30])
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a --backoff flag with no operand instead of treating it as absent', () => {
    expect(() => parseBackoffFlag({ backoff: true }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(() => parseBackoffFlag({ backoff: [] }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a retry delay that is not a non-negative integer', () => {
    expect(() => parseBackoffFlag({ backoff: '5,x' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
    expect(() => parseBackoffFlag({ backoff: '-1' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
  })

  it('forwards the backoff list to queue:listen worker processes', () => {
    expect(buildQueueWorkArgs({ tries: '2', backoff: '5,10' })).toEqual(['queue:work', '--tries', '2', '--backoff', '5,10'])
  })

  it('passes the parsed backoff and tries to the queue worker when queue:work runs', async () => {
    const workerOptions: QueueWorkerRunOptions[] = []
    const context: InternalCommandContext = {
      ...createIo(),
      projectRoot: process.cwd(),
      registry: [],
      loadProject: async () => {
        throw new Error('loadProject should not be called')
      },
    }
    const command = findQueueWorkCommand(createInternalCommands(context, undefined, {
      runQueueWorkCommand: async (_io, _projectRoot, options) => {
        workerOptions.push(options)
      },
    }))
    const prepared = await command.prepare?.({ args: [], flags: { once: true, tries: '2', backoff: '5,10' } }, context)

    await command.run({ projectRoot: process.cwd(), cwd: process.cwd(), args: [], flags: prepared?.flags ?? {}, loadProject: context.loadProject })

    expect(workerOptions).toMatchObject([{ once: true, tries: 2, backoff: [5, 10] }])
  })
})
