import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { loadConfigDirectory } from '@holo-js/config'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createInternalCommands, runCli } from '../src/cli'
import type { RuntimeExecutor } from '../src/command-executors'
import type { IoStreams } from '../src/cli-types'
import { renderScaffoldAppConfig, renderScaffoldEnvFiles } from '../src/project/scaffold/project-renderers'

function createIo(projectRoot: string): { io: IoStreams, stderr: () => string } {
  const stderr = new PassThrough()
  let stderrText = ''
  stderr.on('data', (chunk) => {
    stderrText += String(chunk)
  })
  return {
    io: {
      cwd: projectRoot,
      stdin: new PassThrough() as never,
      stdout: new PassThrough() as never,
      stderr: stderr as never,
    },
    stderr: () => stderrText,
  }
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-app-env-'))
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-env-fixture', private: true }))
  await writeFile(join(root, 'config/app.mjs'), 'export default {}\n')
  await writeFile(join(root, '.env'), 'APP_ENV=development\n')
  return root
}

async function readCachedEnvironmentName(root: string): Promise<string> {
  const cache = JSON.parse(await readFile(join(root, '.holo-js/generated/config-cache.json'), 'utf8')) as {
    environment: { name: string }
  }
  return cache.environment.name
}

describe('application environment option', () => {
  it.each([
    [['--env=test']],
    [['--env', 'test']],
  ])('selects the application environment from %j over the shell and .env', async (tokens) => {
    vi.stubEnv('APP_ENV', 'production')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await createProject()
    const { io, stderr } = createIo(root)

    await expect(runCli(['config:cache', ...tokens], io)).resolves.toBe(0)

    expect(stderr()).toBe('')
    await expect(readCachedEnvironmentName(root)).resolves.toBe('test')
  })

  it('restores APP_ENV after each invocation so later calls do not inherit --env', async () => {
    vi.stubEnv('APP_ENV', undefined)
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await createProject()

    await expect(runCli(['config:cache', '--env=test'], createIo(root).io)).resolves.toBe(0)
    expect(process.env.APP_ENV).toBeUndefined()
    await expect(runCli(['unknown:command', '--env=test'], createIo(root).io)).resolves.toBe(1)
    expect(process.env.APP_ENV).toBeUndefined()

    await expect(runCli(['config:cache'], createIo(root).io)).resolves.toBe(0)
    await expect(readCachedEnvironmentName(root)).resolves.toBe('development')
  })

  it('restores a previous shell APP_ENV after an invocation with --env', async () => {
    vi.stubEnv('APP_ENV', 'production')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await createProject()

    await expect(runCli(['config:cache', '--env=test'], createIo(root).io)).resolves.toBe(0)

    expect(process.env.APP_ENV).toBe('production')
  })

  it('uses APP_ENV from .env when no option or shell value is given', async () => {
    vi.stubEnv('APP_ENV', undefined)
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await createProject()
    const { io } = createIo(root)

    await expect(runCli(['config:cache'], io)).resolves.toBe(0)

    await expect(readCachedEnvironmentName(root)).resolves.toBe('development')
  })

  it('rejects --env without a value', async () => {
    const root = await createProject()
    const { io, stderr } = createIo(root)

    await expect(runCli(['config:cache', '--env'], io)).resolves.toBe(1)

    expect(stderr()).toContain('The --env option requires a value.')
  })

  it.each(['seed', 'migrate:fresh'])('passes the resolved application environment to %s seeding', async (commandName) => {
    vi.stubEnv('APP_ENV', undefined)
    vi.stubEnv('NODE_ENV', 'production')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await createProject()
    const { io } = createIo(root)
    const environments: unknown[] = []
    const runtimeExecutor = (async (_projectRoot: string, kind: string, options: { environment?: unknown }) => {
      if (kind === 'seed') environments.push(options.environment)
    }) as unknown as RuntimeExecutor
    const context = {
      ...io,
      projectRoot: root,
      registry: [],
      loadProject: async () => {
        throw new Error('loadProject should not be called')
      },
    }
    const command = createInternalCommands(context, runtimeExecutor).find(entry => entry.name === commandName)
    const flags: Record<string, boolean> = commandName === 'migrate:fresh' ? { seed: true } : {}

    await command?.run({ projectRoot: root, cwd: root, args: [], flags, loadProject: context.loadProject })

    expect(environments).toEqual(['development'])
  })

  it('scaffolds a development .env and an app config that falls back to production', async () => {
    const root = await createProject()
    const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
    const envFiles = renderScaffoldEnvFiles({ projectName: 'env-app', databaseDriver: 'sqlite', storageDefaultDisk: 'local' })
    await rm(join(root, 'config/app.mjs'))
    await writeFile(join(root, 'config/app.ts'), renderScaffoldAppConfig('env-app').replace("'@holo-js/config'", configEntry))
    await writeFile(join(root, '.env'), envFiles.env)

    expect(envFiles.env).toContain('APP_ENV=development\n')
    await expect(loadConfigDirectory(root, { processEnv: {}, preferCache: false }))
      .resolves.toMatchObject({ app: { env: 'development' } })

    await writeFile(join(root, '.env'), envFiles.env.replace('APP_ENV=development\n', ''))
    await expect(loadConfigDirectory(root, { processEnv: {}, preferCache: false }))
      .resolves.toMatchObject({ app: { env: 'production' } })
  })
})
