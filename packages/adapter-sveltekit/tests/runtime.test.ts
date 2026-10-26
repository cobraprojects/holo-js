import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'
import { cacheDbInternals } from '../../cache-db/src'
import { createSvelteKitHoloHelpers, resetSvelteKitHoloProject, runWithSvelteKitRequestEvent } from '../src'

const projectRoot = resolve(import.meta.dirname, '../../../apps/blog-sveltekit')

afterEach(async () => {
  await resetSvelteKitHoloProject()
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

  it.each(['memory', 'database'] as const)('preserves %s cached data and held locks while concurrent requests resolve uncached helpers', async (driver) => {
    const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-concurrent-runtime-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const options = {
      projectRoot,
      preferCache: false,
      processEnv: {
        ...process.env,
        APP_ENV: 'test',
        NODE_ENV: 'production',
        APP_KEY: 'native-sveltekit-runtime-test-key',
        DB_DRIVER: 'sqlite',
        DB_URL: join(root, 'database.sqlite'),
        DB_SQLITE_URL: join(root, 'database.sqlite'),
        SESSION_DRIVER: 'file',
      },
    }
    const firstHelpers = createSvelteKitHoloHelpers(options)
    const secondHelpers = createSvelteKitHoloHelpers(options)
    await firstHelpers.getApp()
    if (driver === 'database') await cacheDbInternals.prepareCacheDatabaseTables(DB.connection())
    const store = cache.driver(driver)
    let markLocked = () => {}
    const locked = new Promise<void>((resolve) => { markLocked = resolve })
    let markResolved = () => {}
    const resolved = new Promise<void>((resolve) => { markResolved = resolve })
    const event = () => ({
      request: new Request('https://app.test/upload', { method: 'POST' }),
      cookies: { get: () => undefined, set() {}, delete() {} },
    })

    await Promise.all([
      runWithSvelteKitRequestEvent(event(), async () => {
        const lock = store.lock('upload', 30)
        expect(await lock.get()).toBe(true)
        await store.put('upload', 'pending', 30)
        markLocked()
        await resolved
        await expect(lock.release()).resolves.toBe(true)
        await expect(cache.driver(driver).get('upload')).resolves.toBe('pending')
        const nextLock = cache.driver(driver).lock('upload', 30)
        expect(await nextLock.get()).toBe(true)
        await expect(nextLock.release()).resolves.toBe(true)
      }),
      runWithSvelteKitRequestEvent(event(), async () => {
        await locked
        try {
          await Promise.all([firstHelpers.getAuth(), secondHelpers.getSession(), secondHelpers.getApp()])
          expect(await cache.driver(driver).lock('upload', 30).get()).toBe(false)
        } finally {
          markResolved()
        }
      }),
    ])

    cache.resetCacheRuntime()
    await secondHelpers.getApp()
    const restoredLock = cache.driver(driver).lock('upload', 30)
    expect(await restoredLock.get()).toBe(true)
    await expect(restoredLock.release()).resolves.toBe(true)
  })
})
