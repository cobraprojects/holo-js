import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createInternalCommands } from '../src/cli'
import type { RuntimeExecutor } from '../src/command-executors'
import type { IoStreams } from '../src/cli-types'

type RecordedRuntime = { kind: string, options: Record<string, unknown> }

function createStreams(options: { interactive?: boolean, answer?: string } = {}): IoStreams {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.isTTY = options.interactive === true
  stdout.isTTY = options.interactive === true
  if (options.answer !== undefined) {
    stdin.write(`${options.answer}\n`)
  }

  return {
    cwd: process.cwd(),
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: new PassThrough() as never,
  }
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-destructive-'))
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'destructive-fixture', private: true }))
  await writeFile(join(root, 'config/app.mjs'), 'export default {}\n')
  return root
}

function createCommands(root: string, io: IoStreams) {
  const runs: RecordedRuntime[] = []
  const runtimeExecutor = (async (_projectRoot: string, kind: string, options: Record<string, unknown>) => {
    runs.push({ kind, options })
  }) as unknown as RuntimeExecutor
  const context = {
    ...io,
    projectRoot: root,
    registry: [],
    loadProject: async () => {
      throw new Error('loadProject should not be called')
    },
  }
  const commands = createInternalCommands(context, runtimeExecutor)
  const find = (name: string) => {
    const command = commands.find(entry => entry.name === name)
    if (!command) {
      throw new Error(`Missing command ${name}`)
    }

    return command
  }

  return {
    runs,
    async run(name: string, flags: Record<string, boolean> = {}) {
      await find(name).run({ projectRoot: root, cwd: root, args: [], flags, loadProject: context.loadProject })
    },
    async runParsed(name: string, rawFlags: Record<string, boolean>) {
      const command = find(name)
      const prepared = await command.prepare?.({ args: [], flags: rawFlags }, context)
      await command.run({ projectRoot: root, cwd: root, args: [], flags: prepared?.flags ?? {}, loadProject: context.loadProject })
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('destructive database commands', () => {
  it.each([
    ['migrate:fresh', {}],
    ['migrate:rollback', {}],
    ['seed', {}],
  ])('refuses to run %s in production without --force when non-interactive', async (name, flags) => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await expect(commands.run(name, flags)).rejects.toThrow('--force')

    expect(commands.runs).toEqual([])
  })

  it('does not prompt when --no-interactive is passed from the command line, even in a terminal', async () => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams({ interactive: true, answer: 'y' }))

    await expect(commands.runParsed('migrate:rollback', { 'no-interactive': true })).rejects.toThrow('--force')

    expect(commands.runs).toEqual([])
  })

  it('treats a missing APP_ENV as production when deciding whether to confirm', async () => {
    vi.stubEnv('APP_ENV', undefined)
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await expect(commands.run('migrate:rollback')).rejects.toThrow('--force')

    expect(commands.runs).toEqual([])
  })

  it.each([
    ['migrate:fresh', {}, ['fresh']],
    ['migrate:rollback', {}, ['rollback']],
    ['seed', {}, ['seed']],
  ])('runs %s in production with --force without prompting', async (name, flags, kinds) => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await commands.run(name, { ...flags, force: true })

    expect(commands.runs.map(run => run.kind)).toEqual(kinds)
  })

  it('passes force to seeders run by migrate:fresh --seed --force in production', async () => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await commands.run('migrate:fresh', { seed: true, force: true })

    expect(commands.runs).toEqual([
      { kind: 'fresh', options: { seed: false } },
      expect.objectContaining({ kind: 'seed', options: expect.objectContaining({ force: true, environment: 'production' }) }),
    ])
  })

  it.each(['migrate:fresh', 'migrate:rollback', 'seed'])('asks before running %s in production when interactive', async (name) => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams({ interactive: true, answer: 'y' }))

    await commands.run(name)

    expect(commands.runs).toHaveLength(1)
  })

  it.each(['', 'n', 'no'])('cancels a production run when the confirmation answer is %j', async (answer) => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams({ interactive: true, answer }))

    await expect(commands.run('migrate:rollback')).rejects.toThrow('Command canceled.')

    expect(commands.runs).toEqual([])
  })

  it('cancels migrate:fresh --seed before dropping tables when the confirmation is declined', async () => {
    vi.stubEnv('APP_ENV', 'production')
    const root = await createProject()
    const commands = createCommands(root, createStreams({ interactive: true, answer: 'n' }))

    await expect(commands.run('migrate:fresh', { seed: true })).rejects.toThrow('Command canceled.')

    expect(commands.runs).toEqual([])
  })

  it('does not prompt or require --force outside production', async () => {
    vi.stubEnv('APP_ENV', 'development')
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await commands.run('migrate:fresh', { seed: true })
    await commands.run('migrate:rollback')
    await commands.run('seed')

    expect(commands.runs.map(run => run.kind)).toEqual(['fresh', 'seed', 'rollback', 'seed'])
  })

  it('reads the application environment from .env when APP_ENV is not in the shell', async () => {
    vi.stubEnv('APP_ENV', undefined)
    const root = await createProject()
    await writeFile(join(root, '.env'), 'APP_ENV=development\n')
    const commands = createCommands(root, createStreams())

    await commands.run('migrate:rollback')

    expect(commands.runs.map(run => run.kind)).toEqual(['rollback'])
  })
})

describe('migrate --isolated', () => {
  it('passes the isolation request to the runtime', async () => {
    vi.stubEnv('APP_ENV', 'development')
    const root = await createProject()
    const commands = createCommands(root, createStreams())

    await commands.run('migrate', { isolated: true })

    expect(commands.runs).toEqual([{ kind: 'migrate', options: { isolated: true } }])
  })
})
