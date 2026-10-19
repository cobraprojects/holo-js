import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { RequestCookies as NextRequestCookies, ResponseCookies as NextResponseCookies } from 'next/dist/server/web/spec-extension/cookies'
import { expect, it } from 'vitest'
import { adapterNextRuntimeInternals } from '../src/runtime'

it('writes authentication cookies into the consuming Next request scope', async () => {
  const projectRoot = process.env.HOLO_NEXT_PEER_PROJECT ?? resolve(import.meta.dirname, '..')
  const requireHost = createRequire(resolve(projectRoot, 'package.json'))
  const nativeGlobals = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }
  nativeGlobals.AsyncLocalStorage ??= AsyncLocalStorage
  const { workAsyncStorage } = requireHost('next/dist/server/app-render/work-async-storage.external.js') as {
    workAsyncStorage: AsyncLocalStorage<{ route: string, isStaticGeneration: boolean }>
  }
  const { workUnitAsyncStorage } = requireHost('next/dist/server/app-render/work-unit-async-storage.external.js') as {
    workUnitAsyncStorage: AsyncLocalStorage<typeof requestStore>
  }
  const { RequestCookies, ResponseCookies } = requireHost('next/dist/server/web/spec-extension/cookies.js') as {
    RequestCookies: typeof NextRequestCookies
    ResponseCookies: typeof NextResponseCookies
  }
  const mutableCookies = new ResponseCookies(new Headers())
  const cookies = new RequestCookies(new Headers())
  const headers = new Headers()
  const requestStore = {
    type: 'request' as const,
    phase: 'action' as const,
    cookies,
    headers,
    mutableCookies,
    userspaceMutableCookies: mutableCookies,
    asyncApiPromises: { cookies: Promise.resolve(cookies), mutableCookies: Promise.resolve(mutableCookies), headers: Promise.resolve(headers) },
  }
  const previousEnvironment = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await workAsyncStorage.run({ route: '/login', isStaticGeneration: false }, () => workUnitAsyncStorage.run(requestStore, async () => {
      await adapterNextRuntimeInternals.resolveNextAuthRequestAccessors(projectRoot).appendResponseCookie?.('holo_session=synthetic; Path=/; HttpOnly; SameSite=Lax')
    }))
    expect(mutableCookies.get('holo_session')).toMatchObject({ value: 'synthetic', path: '/', httpOnly: true, sameSite: 'lax' })
  } finally {
    process.env.NODE_ENV = previousEnvironment
  }
})

it('reports authentication cookie writes that a server component render cannot make', async () => {
  const projectRoot = process.env.HOLO_NEXT_PEER_PROJECT ?? resolve(import.meta.dirname, '..')
  const requireHost = createRequire(resolve(projectRoot, 'package.json'))
  const nativeGlobals = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }
  nativeGlobals.AsyncLocalStorage ??= AsyncLocalStorage
  const { workAsyncStorage } = requireHost('next/dist/server/app-render/work-async-storage.external.js') as {
    workAsyncStorage: AsyncLocalStorage<{ route: string, isStaticGeneration: boolean }>
  }
  const { workUnitAsyncStorage } = requireHost('next/dist/server/app-render/work-unit-async-storage.external.js') as {
    workUnitAsyncStorage: AsyncLocalStorage<typeof requestStore>
  }
  const { RequestCookies } = requireHost('next/dist/server/web/spec-extension/cookies.js') as {
    RequestCookies: typeof NextRequestCookies
  }
  const { RequestCookiesAdapter } = requireHost('next/dist/server/web/spec-extension/adapters/request-cookies.js') as {
    RequestCookiesAdapter: { seal(cookies: NextRequestCookies): NextRequestCookies }
  }
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers()))
  const headers = new Headers()
  const requestStore = {
    type: 'request' as const,
    phase: 'render' as const,
    cookies,
    headers,
    asyncApiPromises: { cookies: Promise.resolve(cookies), headers: Promise.resolve(headers) },
  }
  const previousEnvironment = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await workAsyncStorage.run({ route: '/admin', isStaticGeneration: false }, () => workUnitAsyncStorage.run(requestStore, async () => {
      await expect(adapterNextRuntimeInternals.resolveNextAuthRequestAccessors(projectRoot).appendResponseCookie?.('holo_session=synthetic; Path=/; HttpOnly; SameSite=Lax')).rejects.toMatchObject({ code: 'cookie_write_unavailable' })
    }))
    expect(cookies.get('holo_session')).toBeUndefined()
  } finally {
    process.env.NODE_ENV = previousEnvironment
  }
})
