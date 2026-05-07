import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HOLO_SERVER_EXTERNAL_PACKAGES = [
  '@holo-js/core',
  '@holo-js/adapter-next',
  '@holo-js/db',
  '@holo-js/config',
  'esbuild',
]

const HOLO_OPTIONAL_SERVER_EXTERNAL_PACKAGES = [
  '@holo-js/auth',
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
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/storage-s3',
  '@holo-js/validation',
] as const

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

interface TurbopackIgnoreIssueRule {
  readonly path: string | RegExp
  readonly title?: string | RegExp
}

interface TurbopackConfig {
  readonly ignoreIssue?: readonly TurbopackIgnoreIssueRule[]
  readonly [key: string]: unknown
}

interface NextConfig {
  readonly serverExternalPackages?: string[]
  readonly outputFileTracingExcludes?: Record<string, string[]>
  readonly turbopack?: TurbopackConfig
  readonly rewrites?: () => Promise<unknown>
  readonly [key: string]: unknown
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.values(value).every(entry => typeof entry === 'string')
}

function readPackageJson(projectRoot: string): PackageJson | undefined {
  const packageJsonPath = resolve(projectRoot, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return undefined
  }

  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  return {
    ...('dependencies' in parsed && isStringRecord(parsed.dependencies) ? { dependencies: parsed.dependencies } : {}),
    ...('devDependencies' in parsed && isStringRecord(parsed.devDependencies) ? { devDependencies: parsed.devDependencies } : {}),
    ...('peerDependencies' in parsed && isStringRecord(parsed.peerDependencies) ? { peerDependencies: parsed.peerDependencies } : {}),
    ...('optionalDependencies' in parsed && isStringRecord(parsed.optionalDependencies) ? { optionalDependencies: parsed.optionalDependencies } : {}),
  }
}

function hasPackage(packageJson: PackageJson, packageName: string): boolean {
  return packageJson.dependencies?.[packageName] !== undefined
    || packageJson.devDependencies?.[packageName] !== undefined
    || packageJson.peerDependencies?.[packageName] !== undefined
    || packageJson.optionalDependencies?.[packageName] !== undefined
}

function resolveInstalledOptionalServerExternalPackages(projectRoot: string): readonly string[] {
  const packageJson = readPackageJson(projectRoot)
  if (!packageJson) {
    return []
  }

  return HOLO_OPTIONAL_SERVER_EXTERNAL_PACKAGES.filter(packageName => hasPackage(packageJson, packageName))
}

export function withHolo<TConfig extends NextConfig>(nextConfig: TConfig = {} as TConfig): TConfig {
  const existingExternal = nextConfig.serverExternalPackages ?? []
  const optionalExternal = resolveInstalledOptionalServerExternalPackages(process.cwd())
  const mergedExternal = [
    ...new Set([...HOLO_SERVER_EXTERNAL_PACKAGES, ...optionalExternal, ...existingExternal]),
  ]

  const existingExcludes = nextConfig.outputFileTracingExcludes ?? {}
  const existingGlobalExcludes = existingExcludes['/*'] ?? []
  const mergedExcludes = {
    ...existingExcludes,
    '/*': [...new Set(['./next.config.ts', './next.config.mjs', ...existingGlobalExcludes])],
  }

  const existingTurbopack = nextConfig.turbopack ?? {}
  const existingIgnoreIssue = existingTurbopack.ignoreIssue ?? []
  const mergedTurbopack: TurbopackConfig = {
    ...existingTurbopack,
    ignoreIssue: [
      ...existingIgnoreIssue,
      {
        path: /next\.config\.(ts|mjs|js)$/,
        title: /Encountered unexpected file in NFT list/,
      },
    ],
  }

  const userRewrites = nextConfig.rewrites

  return {
    ...nextConfig,
    serverExternalPackages: mergedExternal,
    outputFileTracingExcludes: mergedExcludes,
    turbopack: mergedTurbopack,
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
