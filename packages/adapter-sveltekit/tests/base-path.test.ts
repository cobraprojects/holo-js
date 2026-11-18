import type { RequestEvent } from '@sveltejs/kit'
import { requestAppBaseInternals } from '@holo-js/kernel/internal/app-base'
import { createServer, type Plugin } from 'vite'
import { describe, expect, it } from 'vitest'
import { createSvelteKitHoloHooks } from '../src'
import { appPathname, withBase } from '../src/paths'
import { holoSvelteKit } from '../src/vite'

function svelteKitSetup(base: string): Plugin {
  return { name: 'vite-plugin-sveltekit-setup', api: { options: { paths: { base } } } }
}

async function loadBase(plugins: readonly unknown[]): Promise<unknown> {
  const server = await createServer({ configFile: false, logLevel: 'silent', plugins: plugins as Plugin[], server: { middlewareMode: true, ws: false } })
  try {
    const paths = await server.ssrLoadModule('virtual:holo-sveltekit/paths')
    return paths.base
  } finally {
    await server.close()
  }
}

describe('SvelteKit base path', () => {
  it.each([
    ['', '/api/auth/user', '/api/auth/user'],
    ['/dashboard', '/dashboard/api/auth/user', '/api/auth/user'],
    ['/dashboard', '/dashboard', '/'],
    ['/dashboard', '/dashboard/', '/'],
    ['/dashboard', '/dashboardx/api/auth/user', '/dashboardx/api/auth/user'],
  ])('reads the path inside an app with base %j from %s', (base, pathname, expected) => {
    expect(appPathname(pathname, base)).toBe(expected)
  })

  it.each([
    ['', '/login?error=denied', '/login?error=denied'],
    ['/dashboard', '/login?error=denied', '/dashboard/login?error=denied'],
    ['/dashboard', '/', '/dashboard/'],
  ])('prefixes an app path with base %j', (base, path, expected) => {
    expect(withBase(path, base)).toBe(expected)
  })

  it('serves the base path from the app\'s SvelteKit config to the generated hooks', async () => {
    expect(await loadBase([svelteKitSetup('/dashboard'), holoSvelteKit()])).toBe('/dashboard')
  })

  it('defines the same base for Holo browser clients when sveltekit() resolves its plugins asynchronously', async () => {
    const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [Promise.resolve([svelteKitSetup('/dashboard')]), holoSvelteKit()], server: { middlewareMode: true, ws: false } })
    try {
      expect(server.config.define?.__HOLO_APP_BASE__).toBe('"/dashboard"')
      expect((await server.ssrLoadModule('virtual:holo-sveltekit/paths')).base).toBe('/dashboard')
    } finally {
      await server.close()
    }
  })

  it('records the base on each request so Holo security and auth read the path inside the app', async () => {
    const hooks = createSvelteKitHoloHooks({ base: '/dashboard', handle: ({ event }) => new Response(requestAppBaseInternals.pathname(event.request)) })
    const request = new Request('https://app.test/dashboard/broadcasting/auth')
    const response = await hooks.handle({ event: { url: new URL(request.url), request } as RequestEvent, resolve: async () => new Response('') })
    expect(await response.text()).toBe('/broadcasting/auth')
  })

  it('is the only Holo Vite plugin an app registers', async () => {
    const vite = await import('../src/vite')
    expect(Object.keys(vite).filter(name => name.startsWith('holo'))).toEqual(['holoSvelteKit'])
  })

  it('serves an empty base path when SvelteKit sets none', async () => {
    expect(await loadBase([svelteKitSetup(''), holoSvelteKit()])).toBe('')
    expect(await loadBase([holoSvelteKit()])).toBe('')
  })
})
