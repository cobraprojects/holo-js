import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HOLO_SERVER_EXTERNAL_PACKAGES = [
  '@holo-js/core',
  '@holo-js/db',
  '@holo-js/config',
  'esbuild',
]

const HOLO_OPTIONAL_SERVER_EXTERNAL_PACKAGES = [
  '@holo-js/auth-clerk',
  '@holo-js/auth-social',
  '@holo-js/auth-social-apple',
  '@holo-js/auth-social-discord',
  '@holo-js/auth-social-facebook',
  '@holo-js/auth-social-github',
  '@holo-js/auth-social-google',
  '@holo-js/auth-social-linkedin',
  '@holo-js/auth-workos',
  '@holo-js/authorization',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/cache-db',
  '@holo-js/cache-redis',
  '@holo-js/events',
  '@holo-js/forms',
  '@holo-js/mail',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/queue-db',
  '@holo-js/queue-redis',
  '@holo-js/realtime',
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/storage-s3',
  '@holo-js/validation',
] as const

const HOLO_TRANSPILED_PACKAGES = [
  '@holo-js/adapter-next',
  '@holo-js/auth',
] as const
const HOLO_TRANSPILED_PACKAGE_SET = new Set<string>(HOLO_TRANSPILED_PACKAGES)
const NEXT_AUTH_INTERRUPTS_ENV = '__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS'
const CORE_RUNTIME_CHUNK_PATH = /packages[\\/]core[\\/]dist[\\/].+\.mjs$/
const OPTIONAL_RUNTIME_IMPORT_ISSUE = /Module not found: Can't resolve (?:'@holo-js\/storage-s3'|<dynamic>)/

type PackageDependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
type PackageDependencyMap = Readonly<Record<string, string>>
type PackageManifest = Partial<Record<PackageDependencyField, PackageDependencyMap>>

const PACKAGE_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const satisfies readonly PackageDependencyField[]

interface TurbopackIgnoreIssueRule {
  readonly path: string | RegExp
  readonly title?: string | RegExp
}

interface TurbopackConfig {
  readonly ignoreIssue?: readonly TurbopackIgnoreIssueRule[]
  readonly rules?: Record<string, unknown>
  readonly [key: string]: unknown
}

interface NextConfig {
  readonly serverExternalPackages?: string[]
  readonly transpilePackages?: string[]
  readonly outputFileTracingExcludes?: Record<string, string[]>
  readonly experimental?: Record<string, unknown>
  readonly turbopack?: TurbopackConfig
  readonly rewrites?: () => Promise<unknown>
  readonly webpack?: (config: WebpackConfig, context: WebpackConfigContext) => WebpackConfig
  readonly [key: string]: unknown
}

type WebpackConfig = {
  module?: {
    rules?: unknown[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

type WebpackConfigContext = {
  readonly isServer: boolean
  readonly [key: string]: unknown
}

function isPackageDependencyMap(value: unknown): value is PackageDependencyMap {
  return value !== null
    && typeof value === 'object'
    && Object.values(value).every(dependency => typeof dependency === 'string')
}

function readProjectPackageManifest(): PackageManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const manifest: PackageManifest = {}
    for (const field of PACKAGE_DEPENDENCY_FIELDS) {
      const dependencies = (parsed as Partial<Record<PackageDependencyField, unknown>>)[field]
      if (isPackageDependencyMap(dependencies)) {
        manifest[field] = dependencies
      }
    }

    return manifest
  } catch {
    return null
  }
}

function isOptionalServerExternalPackageInstalled(packageName: string, manifest: PackageManifest | null): boolean {
  return PACKAGE_DEPENDENCY_FIELDS.some(field => Boolean(manifest?.[field]?.[packageName]))
}

function createRealtimeDefinitionWebpackRule(loaderPath: string, preserveServerHandlers: boolean): Record<string, unknown> {
  return {
    test: /(?:^|[\\/])server[\\/]realtime[\\/].+\.[cm]?[jt]sx?$/,
    use: [{
      loader: loaderPath,
      options: { preserveServerHandlers },
    }],
  }
}

function createRealtimeDefinitionTurbopackRule(
  loaderPath: string,
  environment: 'browser' | 'server',
): Record<string, unknown> {
  const environmentCondition = environment === 'browser'
    ? 'browser'
    : { any: ['node', 'edge-light'] }

  return {
    condition: {
      all: [
        environmentCondition,
        {
          path: /(?:^|[\\/])server[\\/]realtime[\\/]/,
        },
      ],
    },
    loaders: [{
      loader: loaderPath,
      options: { preserveServerHandlers: environment === 'server' },
    }],
    as: '*.js',
  }
}

export function withHolo<TConfig extends NextConfig>(nextConfig: TConfig = {} as TConfig): TConfig {
  process.env[NEXT_AUTH_INTERRUPTS_ENV] = '1'

  const existingExternal = nextConfig.serverExternalPackages ?? []
  const packageManifest = readProjectPackageManifest()
  const installedOptionalExternal = HOLO_OPTIONAL_SERVER_EXTERNAL_PACKAGES.filter(packageName => (
    isOptionalServerExternalPackageInstalled(packageName, packageManifest)
  ))
  const mergedExternal = [
    ...new Set([...HOLO_SERVER_EXTERNAL_PACKAGES, ...installedOptionalExternal, ...existingExternal]),
  ].filter(packageName => !HOLO_TRANSPILED_PACKAGE_SET.has(packageName))
  const mergedTranspilePackages = [
    ...new Set([...HOLO_TRANSPILED_PACKAGES, ...(nextConfig.transpilePackages ?? [])]),
  ]

  const existingExcludes = nextConfig.outputFileTracingExcludes ?? {}
  const existingGlobalExcludes = existingExcludes['/*'] ?? []
  const mergedExcludes = {
    ...existingExcludes,
    '/*': [...new Set(['./next.config.ts', './next.config.mjs', './next.config.js', ...existingGlobalExcludes])],
  }

  const existingTurbopack = nextConfig.turbopack ?? {}
  const existingIgnoreIssue = existingTurbopack.ignoreIssue ?? []
  const hasRealtime = isOptionalServerExternalPackageInstalled('@holo-js/realtime', packageManifest)
  const realtimeDefinitionLoader = fileURLToPath(new URL('./realtime-definition-loader.mjs', import.meta.url))
  const mergedTurbopack: TurbopackConfig = {
    ...existingTurbopack,
    rules: {
      ...(existingTurbopack.rules ?? {}),
      ...(hasRealtime
        ? {
            '*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}': [
              createRealtimeDefinitionTurbopackRule(realtimeDefinitionLoader, 'browser'),
              createRealtimeDefinitionTurbopackRule(realtimeDefinitionLoader, 'server'),
            ],
          }
        : {}),
    },
    ignoreIssue: [
      ...existingIgnoreIssue,
      {
        path: CORE_RUNTIME_CHUNK_PATH,
        title: OPTIONAL_RUNTIME_IMPORT_ISSUE,
      },
      {
        path: /next\.config\.(ts|mjs|js)$/,
        title: /Encountered unexpected file in NFT list/,
      },
    ],
  }

  const userRewrites = nextConfig.rewrites
  const userWebpack = nextConfig.webpack

  return {
    ...nextConfig,
    experimental: {
      ...(nextConfig.experimental ?? {}),
      authInterrupts: true,
    },
    serverExternalPackages: mergedExternal,
    transpilePackages: mergedTranspilePackages,
    outputFileTracingExcludes: mergedExcludes,
    turbopack: mergedTurbopack,
    webpack(config, context) {
      const nextWebpackConfig = userWebpack?.(config, context) ?? config
      if (!hasRealtime) {
        return nextWebpackConfig
      }

      nextWebpackConfig.module = nextWebpackConfig.module ?? {}
      nextWebpackConfig.module.rules = [
        ...(nextWebpackConfig.module.rules ?? []),
        createRealtimeDefinitionWebpackRule(realtimeDefinitionLoader, context.isServer),
      ]
      return nextWebpackConfig
    },
    async rewrites() {
      const userResult = await userRewrites?.call(this)

      const raw = process.env.STORAGE_ROUTE_PREFIX?.trim() ?? '/storage'
      const needsRewrite = raw && raw !== '/' && raw !== '/storage'

      if (!needsRewrite) {
        return userResult ?? []
      }

      const storageRoutePrefix = `/${raw.replace(/^\/+|\/+$/g, '')}`
      const holoRewrite = {
        source: `${storageRoutePrefix}/:path*`,
        destination: '/storage/:path*',
      }

      if (Array.isArray(userResult)) {
        return [...userResult, holoRewrite]
      }

      if (userResult && typeof userResult === 'object' && !Array.isArray(userResult)) {
        const shaped = userResult as { beforeFiles?: unknown[], afterFiles?: unknown[], fallback?: unknown[] }
        return {
          ...shaped,
          beforeFiles: [...(Array.isArray(shaped.beforeFiles) ? shaped.beforeFiles : []), holoRewrite],
        }
      }

      return [holoRewrite]
    },
  }
}
