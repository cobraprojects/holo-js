import { NextRequest } from 'next/server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

describe('@holo-js/auth framework helpers', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('does not treat cross-origin Next redirects as self redirects', async () => {
    const { routeProtectionInternals } = await import('../src/next/server')

    expect(routeProtectionInternals.isSameUrl(
      new URL('https://app.test/login'),
      new URL('https://other.test/login'),
    )).toBe(false)
  })

  it('keeps Next route protection helpers out of Node-only edge bundles', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'holo-auth-edge-'))
    const entryPath = resolve(tempDir, 'next-route-protection-edge-entry.ts')
    const outputPath = resolve(tempDir, 'next-route-protection-edge-entry.mjs')

    try {
      await writeFile(entryPath, [
        `import { authOnly, guestOnly, protectRoutes } from ${JSON.stringify(resolve(packageRoot, 'src/next/server.ts'))}`,
        'export const proxy = protectRoutes(',
        '  guestOnly({ routes: [\'/login\'], redirectTo: \'/admin\' }),',
        '  authOnly({ routes: [\'/admin/*\'], redirectTo: \'/login\' }),',
        ')',
      ].join('\n'))

      await execFileAsync('bun', [
        'build',
        entryPath,
        '--target=browser',
        '--format=esm',
        '--external',
        'next/server.js',
        '--outfile',
        outputPath,
      ], {
        cwd: packageRoot,
      })

      await expect(readFile(outputPath, 'utf8')).resolves.not.toContain('node:async_hooks')
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  it('keeps the published Next route protection edge condition out of Node-only bundles', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'holo-auth-published-edge-'))
    await symlink(resolve(packageRoot, 'node_modules'), resolve(tempDir, 'node_modules'), 'dir')
    const outDir = resolve(tempDir, 'dist')
    const entryPath = resolve(tempDir, 'published-next-route-protection-edge-entry.ts')
    const outputPath = resolve(tempDir, 'published-next-route-protection-edge-entry.mjs')

    try {
      await execFileAsync('bun', ['run', 'build'], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
      })

      await writeFile(entryPath, [
        `import { authOnly, guestOnly, protectRoutes } from ${JSON.stringify(resolve(outDir, 'next/server.edge.mjs'))}`,
        'export const proxy = protectRoutes(',
        '  guestOnly({ routes: [\'/login\'], redirectTo: \'/admin\' }),',
        '  authOnly({ routes: [\'/admin/*\'], redirectTo: \'/login\' }),',
        ')',
      ].join('\n'))

      await execFileAsync('bun', [
        'build',
        entryPath,
        '--target=browser',
        '--format=esm',
        '--external',
        'next/server.js',
        '--outfile',
        outputPath,
      ], {
        cwd: packageRoot,
      })

      await expect(readFile(outputPath, 'utf8')).resolves.not.toContain('async_hooks')
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  }, 30_000)

  it('clears Next request context after async and throwing callbacks', async () => {
    const globals = globalThis as typeof globalThis & {
      __holoNextRequestStore?: unknown
    }
    delete globals.__holoNextRequestStore
    vi.resetModules()

    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = new NextRequest('https://app.test/request')

    await expect(runWithNextAuthRequest(request, async () => {
      await Promise.resolve()

      return getCurrentNextAuthRequest()
    })).resolves.toBe(request)
    expect(getCurrentNextAuthRequest()).toBeUndefined()
    expect(() => runWithNextAuthRequest(request, () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(getCurrentNextAuthRequest()).toBeUndefined()
  })

  it('does not treat cross-origin SvelteKit redirects as self redirects', async () => {
    const { routeProtectionInternals } = await import('../src/sveltekit/server')

    expect(routeProtectionInternals.isSameUrl(
      new URL('https://app.test/login'),
      new URL('https://other.test/login'),
    )).toBe(false)
  })







  it('restores synchronous Next request context callbacks', async () => {
    const globals = globalThis as typeof globalThis & { __holoNextRequestStore?: unknown }
    delete globals.__holoNextRequestStore
    vi.resetModules()
    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = new NextRequest('https://app.test/request')
    expect(runWithNextAuthRequest(request, () => getCurrentNextAuthRequest())).toBe(request)
    expect(getCurrentNextAuthRequest()).toBeUndefined()
  })

  it('uses a global AsyncLocalStorage implementation for Next request context when available', async () => {
    const globals = globalThis as typeof globalThis & {
      AsyncLocalStorage?: new <TValue>() => {
        getStore(): TValue | undefined
        run<TResult>(value: TValue, callback: () => TResult): TResult
      }
      __holoNextRequestStore?: unknown
    }
    delete globals.__holoNextRequestStore
    vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage)
    vi.resetModules()
    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = new NextRequest('https://app.test/request')
    expect(runWithNextAuthRequest(request, () => getCurrentNextAuthRequest())).toBe(request)
  })
})
