import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeConfigCache } from '@holo-js/config'
import {
  adapterNextInternals,
  createNextHoloHelpers,
  createNextHoloProject,
  initializeNextHoloProject,
  resetNextHoloProject,
} from '../src'
import { withHolo } from '../src/config'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/index.ts'))
const tempDirs: string[] = []
const requireNextModule = createRequire(import.meta.url)

type NextNavigationModule = {
  readonly forbidden: () => never
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-next-adapter-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'server/db/migrations'), { recursive: true })
  await mkdir(join(root, 'server/db/seeders'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Next App',
  env: 'development',
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`, 'utf8')
  await writeFile(join(root, 'config/services.ts'), `
import { defineConfig, env } from ${configEntry}

export default defineConfig({
  services: {
    secret: env('APP_SECRET', 'live-secret'),
  },
})
`, 'utf8')
  return root
}

afterEach(async () => {
  await resetNextHoloProject()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/adapter-next', () => {
  it('initializes a singleton project and exposes typed config helpers', async () => {
    const root = await createProject()
    const project = await initializeNextHoloProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'next-secret',
      },
    })

    expect(project.config.app.name).toBe('Next App')
    expect(project.runtime.initialized).toBe(true)
    expect(project.runtime.useConfig('services').services.secret).toBe('next-secret')

    const helpers = createNextHoloHelpers<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'next-secret',
      },
    })

    await expect(helpers.getApp()).resolves.toBe(project)
    await expect(helpers.getProject()).resolves.toBe(project)
    await expect(helpers.getSession()).resolves.toBeUndefined()
    await expect(helpers.getAuth()).resolves.toBeUndefined()
    await expect(helpers.useConfig('services')).resolves.toEqual({
      services: {
        secret: 'next-secret',
      },
    })
    await expect(helpers.useConfig('services.services.secret')).resolves.toBe('next-secret')
    await expect(helpers.config('services.services.secret')).resolves.toBe('next-secret')
    expect(adapterNextInternals.getState().projectRoot).toBe(root)
  })

  it('allows direct project creation and prefers config cache in production by default', async () => {
    const root = await createProject()
    await writeConfigCache(root, {
      envName: 'production',
      processEnv: {
        ...process.env,
        NODE_ENV: 'production',
        APP_SECRET: 'cached-secret',
      },
    })
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${configEntry}

export default defineConfig({
  services: {
    secret: 'live-secret',
  },
})
`, 'utf8')

    const project = await createNextHoloProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        NODE_ENV: 'production',
        APP_SECRET: 'cached-secret',
      },
    })

    expect(project.config.custom.services).toEqual({
      services: {
        secret: 'cached-secret',
      },
    })
    await project.runtime.shutdown()
  })

  it('rejects conflicting singleton roots and resets cleanly', async () => {
    const root = await createProject()
    const otherRoot = await createProject()

    await initializeNextHoloProject({ projectRoot: root })
    await expect(initializeNextHoloProject({ projectRoot: otherRoot })).rejects.toThrow(`Next Holo project already initialized for "${root}".`)

    await resetNextHoloProject()

    expect(adapterNextInternals.getState().project).toBeUndefined()
  })

  it('resolves default options from process state when explicit values are omitted', () => {
    const cwd = process.cwd()
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      const resolved = adapterNextInternals.resolveOptions()
      expect(resolved.projectRoot).toBe(cwd)
      expect(resolved.runtime.preferCache).toBe(true)
      expect(resolved.runtime.processEnv).toBe(process.env)
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('preserves renderView when resolving framework runtime options', () => {
    const renderView = async ({ view }: { view: string }) => `<div>${view}</div>`

    const resolved = adapterNextInternals.resolveOptions({
      projectRoot: '/tmp/holo-next-render',
      renderView,
    })

    expect(resolved.runtime.renderView).toBe(renderView)
  })

  it('externalizes only installed optional Holo server packages', async () => {
    const root = await createProject()
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@holo-js/auth': 'workspace:*',
        '@holo-js/auth-social-google': 'workspace:*',
      },
      peerDependencies: {
        '@holo-js/auth-social': 'workspace:*',
      },
    }), 'utf8')

    const previousCwd = process.cwd()
    process.chdir(root)

    try {
      const config = withHolo({
        serverExternalPackages: ['custom-runtime'],
        transpilePackages: [],
      })

      expect(config.serverExternalPackages).toEqual(expect.arrayContaining([
        '@holo-js/core',
        '@holo-js/auth-social',
        '@holo-js/auth-social-google',
        'custom-runtime',
      ]))
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth')
      expect(config.transpilePackages).toEqual(expect.arrayContaining([
        '@holo-js/adapter-next',
        '@holo-js/auth',
      ]))
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth-social-github')
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth-clerk')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('lets externalized Next navigation calls throw a forbidden access interrupt', () => {
    const previous = process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS
    delete process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS

    try {
      const { forbidden } = requireNextModule('next/navigation.js') as NextNavigationModule
      const config = withHolo({
        experimental: {
          serverActions: {
            bodySizeLimit: '3mb',
          },
        },
      })

      expect(config.experimental?.serverActions).toEqual({
        bodySizeLimit: '3mb',
      })

      let thrown: unknown
      try {
        forbidden()
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).toMatchObject({
        digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
      })
    } finally {
      process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = previous
    }
  })

  it('excludes Next config files from output file tracing', () => {
    const config = withHolo({
      outputFileTracingExcludes: {
        '/*': ['custom-ignore'],
        '/api/*': ['api-ignore'],
      },
    })

    expect(config.outputFileTracingExcludes?.['/*']).toEqual(expect.arrayContaining([
      './next.config.ts',
      './next.config.mjs',
      './next.config.js',
      'custom-ignore',
    ]))
    expect(config.outputFileTracingExcludes?.['/api/*']).toEqual(['api-ignore'])
  })

  it('preserves existing Turbopack ignore issue rules', () => {
    const existingRule = {
      path: /custom-config$/,
      title: /Custom config warning/,
    }

    const config = withHolo({
      turbopack: {
        customFlag: true,
        ignoreIssue: [existingRule],
      },
    })

    expect(config.turbopack?.customFlag).toBe(true)
    expect(config.turbopack?.ignoreIssue).toEqual([
      existingRule,
      {
        path: /packages[\\/]core[\\/]dist[\\/].+\.mjs$/,
        title: /Module not found: Can't resolve (?:'@holo-js\/storage-s3'|<dynamic>)/,
      },
      {
        path: /next\.config\.(ts|mjs|js)$/,
        title: /Encountered unexpected file in NFT list/,
      },
    ])
  })

  it('returns user rewrites when the storage route prefix does not need an alias', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.env.STORAGE_ROUTE_PREFIX = '/'

    try {
      const config = withHolo({
        rewrites: async () => [{
          source: '/existing/:path*',
          destination: '/existing/:path*',
        }],
      })

      await expect(config.rewrites()).resolves.toEqual([{
        source: '/existing/:path*',
        destination: '/existing/:path*',
      }])
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('mounts generated Holo Panels routes before App Router page catch-alls', async () => {
    const root = await createProject()
    await mkdir(join(root, '.holo-js/generated/panels'), { recursive: true })
    await writeFile(join(root, '.holo-js/generated/panels/panel-routes.json'), JSON.stringify({
      routes: [
        { domain: null, method: 'GET', panelId: 'admin', scope: 'public', source: '/admin/health' },
        { domain: '{tenant}.example.com', method: 'POST', panelId: 'admin', scope: 'authenticated-tenant', source: '/admin/settings/:section' },
      ],
      version: 1,
    }), 'utf8')
    const previousCwd = process.cwd()
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.chdir(root)
    delete process.env.STORAGE_ROUTE_PREFIX

    try {
      const config = withHolo({
        rewrites: async () => [{ source: '/existing', destination: '/existing' }],
      })
      await expect(config.rewrites()).resolves.toEqual({
        afterFiles: [{ source: '/existing', destination: '/existing' }],
        beforeFiles: [
          { destination: '/holo/panels/admin/custom-route?panelRoute=/admin/health', source: '/admin/health' },
          {
            destination: '/holo/panels/admin/custom-route?panelRoute=/admin/settings/:section',
            has: [{ type: 'host', value: '(?<tenant>[^.]+)\\.example\\.com' }],
            source: '/admin/settings/:section',
          },
        ],
      })
    } finally {
      process.chdir(previousCwd)
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('returns an empty rewrite list when no storage alias or user rewrites exist', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    delete process.env.STORAGE_ROUTE_PREFIX

    try {
      await expect(withHolo().rewrites?.()).resolves.toEqual([])
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('appends the storage route rewrite to array rewrites', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.env.STORAGE_ROUTE_PREFIX = ' /assets/ '

    try {
      const config = withHolo({
        rewrites: async () => [{
          source: '/existing/:path*',
          destination: '/existing/:path*',
        }],
      })

      await expect(config.rewrites()).resolves.toEqual([
        {
          source: '/existing/:path*',
          destination: '/existing/:path*',
        },
        {
          source: '/assets/:path*',
          destination: '/storage/:path*',
        },
      ])
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('adds the storage route rewrite to shaped rewrite results', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.env.STORAGE_ROUTE_PREFIX = '/files'

    try {
      const config = withHolo({
        rewrites: async () => ({
          beforeFiles: [{
            source: '/before/:path*',
            destination: '/before/:path*',
          }],
          afterFiles: [{
            source: '/after/:path*',
            destination: '/after/:path*',
          }],
        }),
      })

      await expect(config.rewrites()).resolves.toEqual({
        beforeFiles: [
          {
            source: '/before/:path*',
            destination: '/before/:path*',
          },
          {
            source: '/files/:path*',
            destination: '/storage/:path*',
          },
        ],
        afterFiles: [{
          source: '/after/:path*',
          destination: '/after/:path*',
        }],
      })
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('creates shaped rewrite beforeFiles when the user result omits them', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.env.STORAGE_ROUTE_PREFIX = '/files'

    try {
      const config = withHolo({
        rewrites: async () => ({
          fallback: [{
            source: '/fallback/:path*',
            destination: '/fallback/:path*',
          }],
        }),
      })

      await expect(config.rewrites()).resolves.toEqual({
        beforeFiles: [{
          source: '/files/:path*',
          destination: '/storage/:path*',
        }],
        fallback: [{
          source: '/fallback/:path*',
          destination: '/fallback/:path*',
        }],
      })
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('uses the storage route rewrite when user rewrites have an unsupported shape', async () => {
    const previousStorageRoutePrefix = process.env.STORAGE_ROUTE_PREFIX
    process.env.STORAGE_ROUTE_PREFIX = '/files'

    try {
      const config = withHolo({
        rewrites: async () => false,
      })

      await expect(config.rewrites()).resolves.toEqual([{
        source: '/files/:path*',
        destination: '/storage/:path*',
      }])
    } finally {
      process.env.STORAGE_ROUTE_PREFIX = previousStorageRoutePrefix
    }
  })

  it('skips optional Holo packages when package.json is not an object', async () => {
    const root = await createProject()
    await writeFile(join(root, 'package.json'), 'null', 'utf8')

    const previousCwd = process.cwd()
    process.chdir(root)

    try {
      const config = withHolo()

      expect(config.serverExternalPackages).toEqual(expect.arrayContaining([
        '@holo-js/core',
      ]))
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('ignores malformed package dependency fields', async () => {
    const root = await createProject()
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@holo-js/auth': 1,
      },
      devDependencies: ['@holo-js/auth-social-google'],
      optionalDependencies: {
        '@holo-js/auth-social': 'workspace:*',
      },
    }), 'utf8')

    const previousCwd = process.cwd()
    process.chdir(root)

    try {
      const config = withHolo()

      expect(config.serverExternalPackages).toContain('@holo-js/auth-social')
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth')
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth-social-google')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('skips optional Holo packages when package.json cannot be parsed', async () => {
    const root = await createProject()
    await writeFile(join(root, 'package.json'), '{', 'utf8')

    const previousCwd = process.cwd()
    process.chdir(root)

    try {
      const config = withHolo()

      expect(config.serverExternalPackages).toEqual(expect.arrayContaining([
        '@holo-js/core',
      ]))
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth')
      expect(config.serverExternalPackages).not.toContain('@holo-js/auth-social')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('configures realtime definitions for browser and server rendering builds', async () => {
    const root = await createProject()
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { '@holo-js/realtime': 'workspace:*' },
    }), 'utf8')
    const previousCwd = process.cwd()
    process.chdir(root)

    try {
      const userWebpack = vi.fn((config: Record<string, unknown>) => ({ ...config, transformed: true }))
      const config = withHolo({ webpack: userWebpack })
      const webpack = config.webpack as unknown as (
        config: Record<string, unknown>,
        context: { readonly isServer: boolean },
      ) => Record<string, unknown>
      const client = webpack({}, { isServer: false }) as {
        transformed: boolean
        module: { rules: Array<{ test: RegExp, use: Array<{ loader: string, options: { preserveServerHandlers: boolean } }> }> }
      }
      expect(client.transformed).toBe(true)
      expect(client.module.rules).toHaveLength(1)
      expect(client.module.rules[0]?.test.test('server/realtime/posts.ts')).toBe(true)
      expect(client.module.rules[0]?.use[0]).toMatchObject({
        loader: expect.stringContaining('realtime-definition-loader'),
        options: { preserveServerHandlers: false },
      })

      const server = webpack({}, { isServer: true }) as {
        transformed: boolean
        module: { rules: Array<{ test: RegExp, use: Array<{ loader: string, options: { preserveServerHandlers: boolean } }> }> }
      }
      expect(server.transformed).toBe(true)
      expect(server.module.rules).toHaveLength(1)
      expect(server.module.rules[0]?.use[0]).toMatchObject({
        loader: expect.stringContaining('realtime-definition-loader'),
        options: { preserveServerHandlers: true },
      })
      expect(userWebpack).toHaveBeenCalledTimes(2)

      const defaultWebpack = withHolo().webpack as unknown as (
        config: Record<string, unknown>,
        context: { readonly isServer: boolean },
      ) => Record<string, unknown>
      expect(defaultWebpack({}, { isServer: false })).toMatchObject({
        module: { rules: expect.any(Array) },
      })
      const turbopack = (config as { readonly turbopack?: { readonly rules?: Record<string, unknown> } }).turbopack
      expect(turbopack?.rules).toMatchObject({
        '*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}': [
          expect.objectContaining({
            loaders: [expect.objectContaining({ options: { preserveServerHandlers: false } })],
          }),
          expect.objectContaining({
            loaders: [expect.objectContaining({ options: { preserveServerHandlers: true } })],
          }),
        ],
      })
    } finally {
      process.chdir(previousCwd)
    }
  })
})
