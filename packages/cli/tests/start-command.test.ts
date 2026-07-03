import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createInternalCommands } from '../src/cli'
import { runProjectStartServer } from '../src/dev'
import type { InternalCommandContext, IoStreams } from '../src/cli-types'

function createIo(projectRoot: string): IoStreams {
  return {
    cwd: projectRoot,
    stdin: new PassThrough() as never,
    stdout: new PassThrough() as never,
    stderr: new PassThrough() as never,
  }
}

describe('start command', () => {
  it('forwards production server arguments to the framework runner', async () => {
    const projectRoot = '/tmp/holo-start'
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const spawn = vi.fn((_command: string, _args?: readonly string[]) => {
      queueMicrotask(() => child.emit('close', 0))
      return child as never
    })

    await expect(runProjectStartServer(
      createIo(projectRoot),
      projectRoot,
      spawn as never,
      ['--hostname', '0.0.0.0', '--port', '3072'],
    )).resolves.toBeUndefined()

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        `${projectRoot}/.holo-js/framework/run.mjs`,
        'start',
        '--hostname',
        '0.0.0.0',
        '--port',
        '3072',
      ],
      expect.objectContaining({ cwd: projectRoot }),
    )
  })

  it('serializes holo start arguments and flags for the project start executor', async () => {
    const projectRoot = '/tmp/holo-start'
    const context: InternalCommandContext = {
      ...createIo(projectRoot),
      projectRoot,
      registry: [],
      loadProject: async () => {
        throw new Error('loadProject should not be called')
      },
    }
    const runProjectStartServer = vi.fn(async () => {})
    const commands = createInternalCommands(
      context,
      undefined,
      {},
      { runProjectStartServer: runProjectStartServer as never },
    )
    const start = commands.find(command => command.name === 'start')

    const prepared = await start?.prepare?.({
      args: ['standalone'],
      flags: { hostname: '0.0.0.0', port: '3072', turbo: true },
    }, context)

    expect(prepared).toEqual({
      args: ['standalone'],
      flags: { hostname: '0.0.0.0', port: '3072', turbo: true },
    })

    await start?.run({
      projectRoot,
      cwd: projectRoot,
      args: prepared?.args ?? [],
      flags: prepared?.flags ?? {},
      loadProject: context.loadProject,
    })

    expect(runProjectStartServer).toHaveBeenCalledWith(context, projectRoot, undefined, [
      'standalone',
      '--hostname',
      '0.0.0.0',
      '--port',
      '3072',
      '--turbo',
    ])
  })
})
