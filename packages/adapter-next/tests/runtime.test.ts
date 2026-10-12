import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { resetHoloRuntime } from '../../core/src/portable/holo'
import { createNextHoloHelpers, createNextRequestContext, runWithNextRequest } from '../src/runtime'

const projectRoot = resolve(import.meta.dirname, '../../../apps/blog-next')

afterEach(async () => {
  await resetHoloRuntime()
})

describe('Next native runtime', () => {
  it('reads native Next cookies and standard HTTP cookies without inventing missing values', () => {
    for (const request of [
      new Request('https://app.test', { headers: { cookie: 'plain=value; encoded%20name=encoded%20value; invalid; empty=' } }),
      new NextRequest('https://app.test', { headers: { cookie: 'plain=value; encoded%20name=encoded%20value; invalid; empty=' } }),
    ]) {
      const context = createNextRequestContext(request)
      expect(context.cookies.get('plain')).toEqual({ value: 'value' })
      expect(context.cookies.get(request instanceof NextRequest ? 'encoded%20name' : 'encoded name')).toEqual({ value: 'encoded value' })
      expect(context.cookies.get('empty')).toEqual({ value: '' })
      expect(context.cookies.get('missing')).toBeUndefined()
      expect(context.headers.get('cookie')).toBe(request.headers.get('cookie'))
    }
  })

  it('boots the existing Next app with real SQLite and session services through its runtime helpers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-next-native-runtime-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const helpers = createNextHoloHelpers({
      projectRoot,
      preferCache: false,
      processEnv: {
        ...process.env,
        APP_NAME: 'blog-next',
        APP_KEY: 'native-next-runtime-test-key',
        DB_DRIVER: 'sqlite',
        DB_URL: join(root, 'database.sqlite'),
        DB_SQLITE_URL: join(root, 'database.sqlite'),
        SESSION_DRIVER: 'file',
      },
    })
    const app = await helpers.getApp()
    expect(app.projectRoot).toBe(projectRoot)
    expect(await helpers.config('app.name')).toBe('blog-next')
    expect(await helpers.useConfig('database.defaultConnection')).toBe('main')
    expect((await helpers.getProject()).projectRoot).toBe(projectRoot)
    const session = await helpers.getSession()
    if (!session) throw new Error('The native app session service was not initialized')
    await expect(session.read('missing-native-session')).resolves.toBeNull()
    const nativeAuth = await helpers.getAuth()
    if (!nativeAuth) throw new Error('The native app auth service was not initialized')
    await runWithNextRequest(createNextRequestContext(new NextRequest('http://localhost:3000')), async () => {
      await expect(nativeAuth.user()).resolves.toBeNull()
      expect(() => nativeAuth.guard('missing')).toThrow(expect.objectContaining({ code: 'guard_not_configured' }))
    })
  })
})
