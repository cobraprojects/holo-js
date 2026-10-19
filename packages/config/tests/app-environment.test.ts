import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory, loadEnvironment, resetConfigRuntime, resolveAppEnvironment } from '../src'

const tempDirs: string[] = []
const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../src/index.ts'))

async function createProject(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-app-env-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, 'utf8')
  }
  return root
}

afterEach(async () => {
  resetConfigRuntime()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('application environment', () => {
  it('resolves APP_ENV and treats a missing value as production', () => {
    expect(resolveAppEnvironment({ APP_ENV: 'development' })).toBe('development')
    expect(resolveAppEnvironment({ APP_ENV: 'test' })).toBe('test')
    expect(resolveAppEnvironment({})).toBe('production')
    expect(resolveAppEnvironment({ APP_ENV: '' })).toBe('production')
  })

  it('ignores HOLO_ENV and NODE_ENV', () => {
    expect(resolveAppEnvironment({ HOLO_ENV: 'development', NODE_ENV: 'test' })).toBe('production')
    expect(resolveAppEnvironment({ APP_ENV: 'test', HOLO_ENV: 'development', NODE_ENV: 'development' })).toBe('test')
  })

  it('rejects an unknown APP_ENV', () => {
    expect(() => resolveAppEnvironment({ APP_ENV: 'staging' })).toThrow(
      'Invalid APP_ENV "staging". Use development, production, or test.',
    )
  })

  it('reads APP_ENV from .env and selects env files from it', async () => {
    const root = await createProject({
      '.env': 'APP_ENV=development\nAPP_NAME=Base\n',
      '.env.development': 'APP_NAME=Development\n',
      '.env.production': 'APP_NAME=Production\n',
    })

    const environment = await loadEnvironment({ cwd: root, processEnv: {} })

    expect(environment.name).toBe('development')
    expect(environment.loadedFiles.map(file => basename(file))).toEqual(['.env', '.env.development'])
    expect(environment.values.APP_NAME).toBe('Development')
  })

  it('runs as production when APP_ENV is missing everywhere', async () => {
    const root = await createProject({
      '.env': 'APP_NAME=Base\n',
      '.env.development': 'APP_NAME=Development\n',
      '.env.production': 'APP_NAME=Production\n',
    })

    const environment = await loadEnvironment({ cwd: root, processEnv: { NODE_ENV: 'development', HOLO_ENV: 'development' } })

    expect(environment.name).toBe('production')
    expect(environment.loadedFiles.map(file => basename(file))).toEqual(['.env', '.env.production'])
    expect(environment.values.APP_NAME).toBe('Production')
  })

  it('lets the shell APP_ENV override .env', async () => {
    const root = await createProject({
      '.env': 'APP_ENV=development\n',
      '.env.development': 'APP_NAME=Development\n',
      '.env.test': 'APP_NAME=Test\n',
    })

    const environment = await loadEnvironment({ cwd: root, processEnv: { APP_ENV: 'test' } })

    expect(environment.name).toBe('test')
    expect(environment.loadedFiles.map(file => basename(file))).toEqual(['.env', '.env.test'])
    expect(environment.values.APP_ENV).toBe('test')
    expect(environment.values.APP_NAME).toBe('Test')
  })

  it('lets an explicit environment name override the shell and .env', async () => {
    const root = await createProject({
      '.env': 'APP_ENV=development\n',
      '.env.test': 'APP_NAME=Test\n',
    })

    const environment = await loadEnvironment({ cwd: root, envName: 'test', processEnv: { APP_ENV: 'production' } })

    expect(environment.name).toBe('test')
    expect(environment.values.APP_ENV).toBe('test')
    expect(environment.values.APP_NAME).toBe('Test')
  })

  it('keeps APP_ENV equal to the resolved environment when a later env file sets it', async () => {
    const root = await createProject({
      '.env': 'APP_ENV=development\n',
      '.env.local': 'APP_ENV=test\n',
    })

    const environment = await loadEnvironment({ cwd: root, processEnv: {} })

    expect(environment.name).toBe('development')
    expect(environment.values.APP_ENV).toBe('development')
  })

  it('lets an empty shell APP_ENV override .env', async () => {
    const root = await createProject({ '.env': 'APP_ENV=development\n' })

    const environment = await loadEnvironment({ cwd: root, processEnv: { APP_ENV: '' } })

    expect(environment.name).toBe('production')
  })

  it('rejects an unknown app.env in config', async () => {
    const root = await createProject({ '.env': 'APP_ENV=development\n' })
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({ env: 'staging' as 'production' })
`, 'utf8')

    await expect(loadConfigDirectory(root, { processEnv: {} })).rejects.toThrow(
      'Invalid application environment "staging". Use development, production, or test.',
    )
  })

  it('rejects an unknown APP_ENV in .env', async () => {
    const root = await createProject({ '.env': 'APP_ENV=local\n' })

    await expect(loadEnvironment({ cwd: root, processEnv: {} })).rejects.toThrow(
      'Invalid APP_ENV "local". Use development, production, or test.',
    )
  })

  it('defaults app.env to the resolved application environment', async () => {
    const root = await createProject({ '.env': 'APP_ENV=test\n' })
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({ name: 'Env App' })
`, 'utf8')

    const loaded = await loadConfigDirectory(root, { processEnv: {} })

    expect(loaded.app.env).toBe('test')
  })

  it('defaults app.env to production without an app config or APP_ENV', async () => {
    const root = await createProject()

    const loaded = await loadConfigDirectory(root, { processEnv: {} })

    expect(loaded.app.env).toBe('production')
  })
})
