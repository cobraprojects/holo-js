import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { resolveRequestUrl } from '@holo-js/kernel'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { field, schema, validate } from '@holo-js/validation'
import { resetHoloRuntime } from '../../core/src/portable/holo'
import { adapterNextRuntimeInternals, createNextHoloHelpers, createNextRequestContext, runWithNextRequest } from '../src/runtime'

const projectRoot = resolve(import.meta.dirname, '../../../apps/blog-next')

afterEach(async () => {
  await resetHoloRuntime()
})

describe('Next native runtime', () => {
  it('retains the request URL so its public origin and path can be resolved from Host', () => {
    const request = new NextRequest('http://localhost:43201/auth/presentation?theme=light', {
      headers: { host: '127.0.0.1:43201' },
    })
    const context = createNextRequestContext(request)
    expect(resolveRequestUrl(context).href).toBe('http://127.0.0.1:43201/auth/presentation?theme=light')
  })

  it('answers route handler validation failures with a 422 that omits submitted passwords', async () => {
    const login = schema({ email: field.string().required().email(), password: field.password().required() })
    const handler = adapterNextRuntimeInternals.routeHandler(async (request: Request) => {
      await validate(request, login)
      return new Response('ok')
    })

    const response = await handler(new Request('https://app.test/api/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'invalid', password: 'next-password' }),
    }))

    expect(response.status).toBe(422)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ status: 422, values: { email: 'invalid' } })
    expect(body).not.toContain('next-password')
  })

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
