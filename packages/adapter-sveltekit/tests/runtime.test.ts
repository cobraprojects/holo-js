import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { resetHoloRuntime } from '../../core/src/portable/holo'
import { createSvelteKitHoloHelpers } from '../src'

const projectRoot = resolve(import.meta.dirname, '../../../apps/blog-sveltekit')

afterEach(async () => {
  await resetHoloRuntime()
})

describe('SvelteKit native runtime', () => {
  it('boots the existing SvelteKit app with real SQLite and session services through its runtime helpers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-native-runtime-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const helpers = createSvelteKitHoloHelpers({
      projectRoot,
      preferCache: false,
      processEnv: {
        ...process.env,
        APP_NAME: 'blog-sveltekit',
        APP_KEY: 'native-sveltekit-runtime-test-key',
        DB_DRIVER: 'sqlite',
        DB_URL: join(root, 'database.sqlite'),
        DB_SQLITE_URL: join(root, 'database.sqlite'),
        SESSION_DRIVER: 'file',
      },
    })
    const app = await helpers.getApp()
    expect(app.projectRoot).toBe(projectRoot)
    expect(await helpers.config('app.name')).toBe('blog-sveltekit')
    expect(await helpers.useConfig('database.defaultConnection')).toBe('main')
    expect((await helpers.getProject()).projectRoot).toBe(projectRoot)
    const session = await helpers.getSession()
    if (!session) throw new Error('The native app session service was not initialized')
    await expect(session.read('missing-native-session')).resolves.toBeNull()
    const nativeAuth = await helpers.getAuth()
    if (!nativeAuth) throw new Error('The native app auth service was not initialized')
    await expect(nativeAuth.user()).resolves.toBeNull()
    expect(() => nativeAuth.guard('missing')).toThrow(expect.objectContaining({ code: 'guard_not_configured' }))
  })
})
