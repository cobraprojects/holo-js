import { createServer, type Plugin } from 'vite'
import { describe, expect, it } from 'vitest'
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

  it('is the only Holo Vite plugin an app registers', async () => {
    const vite = await import('../src/vite')
    expect(Object.keys(vite).filter(name => name.startsWith('holo'))).toEqual(['holoSvelteKit'])
  })

  it('serves an empty base path when SvelteKit sets none', async () => {
    expect(await loadBase([svelteKitSetup(''), holoSvelteKit()])).toBe('')
    expect(await loadBase([holoSvelteKit()])).toBe('')
  })
})
