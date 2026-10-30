import 'next/dist/server/node-environment'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { resolveRequestUrl } from '@holo-js/kernel'
import { actionAsyncStorage, type ActionStore } from 'next/dist/server/app-render/action-async-storage.external.js'
import { workUnitAsyncStorage, type WorkUnitStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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

describe('Next server actions', () => {
  const login = schema({ email: field.string().required().email(), password: field.password().required() })
  const submitInvalidLogin = async () => {
    await validate({ email: 'invalid', password: 'next-password' }, login)
  }
  const registerServerAction = <TArgs extends readonly unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>) => (
    Object.defineProperty(adapterNextRuntimeInternals.serverAction(action), '$$id', { value: `7f${'a'.repeat(40)}` })
  )
  const runRequest = <TResult>(phase: string, actionId: string, callback: () => Promise<TResult>, actionStore: ActionStore = { isAction: true }) => {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(import.meta.dirname, '..'))
    const store = { type: 'request', phase, headers: new Headers({ 'next-action': actionId }) } as unknown as WorkUnitStore
    return actionAsyncStorage.run(actionStore, () => workUnitAsyncStorage.run(store, callback))
  }
  const invokedId = `40${'a'.repeat(40)}`

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers the invoked fetch action with the validation failure instead of throwing it', async () => {
    const action = registerServerAction(submitInvalidLogin)

    const result = await runRequest('action', invokedId, () => action())

    expect(result).toMatchObject({ ok: false, status: 422, errors: { email: expect.any(Array) } })
    expect(JSON.stringify(result)).not.toContain('next-password')
  })

  it('keeps throwing outside the invoked fetch action', async () => {
    const action = registerServerAction(submitInvalidLogin)
    const nested = registerServerAction(async (depth: number): Promise<unknown> => depth === 0 ? await nested(1).catch((error: unknown) => ({ caught: error })) : await submitInvalidLogin())

    await expect(action()).rejects.toMatchObject({ status: 422 })
    await expect(runRequest('render', invokedId, () => action())).rejects.toMatchObject({ status: 422 })
    await expect(runRequest('action', invokedId, () => action(), { isAction: true, isAppRoute: true })).rejects.toMatchObject({ status: 422 })
    await expect(runRequest('action', `40${'b'.repeat(40)}`, () => action())).rejects.toMatchObject({ status: 422 })
    expect(await runRequest('action', invokedId, () => nested(0))).toMatchObject({ caught: { status: 422 } })
  })

  it('rethrows errors that are not validation or rate-limit failures', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/admin;307;' })
    const action = registerServerAction(async () => {
      throw redirect
    })

    await expect(runRequest('action', invokedId, () => action())).rejects.toBe(redirect)
  })
})
