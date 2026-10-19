import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBroadcastIntoProject } from '../src/project/scaffold'
import { renderScaffoldPackageJson, scaffoldProject } from '../src/project/scaffold/framework'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function readEnvValue(contents: string, key: string): string | undefined {
  return contents
    .split('\n')
    .find(line => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
}

async function scaffoldBroadcastApp(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-generated-secrets-'))
  roots.push(projectRoot)
  await scaffoldProject(projectRoot, {
    projectName: 'Secrets App',
    framework: 'next',
    databaseDriver: 'sqlite',
    packageManager: 'bun',
    storageDefaultDisk: 'local',
    optionalPackages: ['broadcast'],
  })
  return projectRoot
}

describe('generated application secrets', () => {
  it('writes generated APP_KEY and broadcast credentials into .env and leaves .env.example blank', async () => {
    const projectRoot = await scaffoldBroadcastApp()
    const env = await readFile(join(projectRoot, '.env'), 'utf8')
    const example = await readFile(join(projectRoot, '.env.example'), 'utf8')

    expect(readEnvValue(env, 'APP_KEY')).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(readEnvValue(env, 'BROADCAST_APP_ID')).toMatch(/^[a-f0-9]{16}$/)
    expect(readEnvValue(env, 'BROADCAST_APP_KEY')).toMatch(/^[a-f0-9]{32}$/)
    expect(readEnvValue(env, 'BROADCAST_APP_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(readEnvValue(example, 'APP_KEY')).toBe('')
    expect(readEnvValue(example, 'BROADCAST_APP_ID')).toBe('')
    expect(readEnvValue(example, 'BROADCAST_APP_KEY')).toBe('')
    expect(readEnvValue(example, 'BROADCAST_APP_SECRET')).toBe('')
  })

  it('generates different credentials for each scaffolded project', async () => {
    const first = await readFile(join(await scaffoldBroadcastApp(), '.env'), 'utf8')
    const second = await readFile(join(await scaffoldBroadcastApp(), '.env'), 'utf8')

    expect(readEnvValue(first, 'APP_KEY')).not.toBe(readEnvValue(second, 'APP_KEY'))
    expect(readEnvValue(first, 'BROADCAST_APP_KEY')).not.toBe(readEnvValue(second, 'BROADCAST_APP_KEY'))
    expect(readEnvValue(first, 'BROADCAST_APP_SECRET')).not.toBe(readEnvValue(second, 'BROADCAST_APP_SECRET'))
  })

  it('reads broadcast credentials from env without literal fallbacks', async () => {
    const projectRoot = await scaffoldBroadcastApp()
    const broadcastConfig = await readFile(join(projectRoot, 'config/broadcast.ts'), 'utf8')

    expect(broadcastConfig).toContain("appId: env('BROADCAST_APP_ID'),")
    expect(broadcastConfig).toContain("key: env('BROADCAST_APP_KEY'),")
    expect(broadcastConfig).toContain("secret: env('BROADCAST_APP_SECRET'),")
    expect(broadcastConfig).not.toContain('app-key')
    expect(broadcastConfig).not.toContain('app-secret')
    expect(broadcastConfig).not.toContain('app-id')
  })

  it('backfills generated broadcast credentials into an existing app env without replacing set values', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-generated-secrets-'))
    roots.push(projectRoot)
    await scaffoldProject(projectRoot, {
      projectName: 'Existing App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })
    const existingKey = readEnvValue(await readFile(join(projectRoot, '.env'), 'utf8'), 'APP_KEY')
    const result = await installBroadcastIntoProject(projectRoot)
    const env = await readFile(join(projectRoot, '.env'), 'utf8')

    expect(result.updatedEnv).toBe(true)
    expect(readEnvValue(env, 'APP_KEY')).toBe(existingKey)
    expect(readEnvValue(env, 'BROADCAST_APP_ID')).toMatch(/^[a-f0-9]{16}$/)
    expect(readEnvValue(env, 'BROADCAST_APP_KEY')).toMatch(/^[a-f0-9]{32}$/)
    expect(readEnvValue(env, 'BROADCAST_APP_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('backfills broadcast credentials in the scaffolded prepare script only for broadcast projects', () => {
    const base = {
      projectName: 'Secrets App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    } as const
    const withBroadcast = JSON.parse(renderScaffoldPackageJson({ ...base, optionalPackages: ['broadcast'] })) as { scripts: Record<string, string> }
    const withoutBroadcast = JSON.parse(renderScaffoldPackageJson({ ...base, optionalPackages: [] })) as { scripts: Record<string, string> }

    expect(withBroadcast.scripts.prepare).toBe('holo key:generate && holo install broadcast && holo prepare')
    expect(withoutBroadcast.scripts.prepare).toBe('holo key:generate && holo prepare')
  })

  it('keeps the config cache out of version control', async () => {
    const projectRoot = await scaffoldBroadcastApp()
    const gitignore = await readFile(join(projectRoot, '.gitignore'), 'utf8')

    expect(gitignore.split('\n')).toContain('.holo-js/generated')
  })
})
