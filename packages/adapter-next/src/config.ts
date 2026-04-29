const HOLO_SERVER_EXTERNAL_PACKAGES = [
  '@holo-js/core',
  '@holo-js/adapter-next',
  '@holo-js/db',
  '@holo-js/config',
  'esbuild',
]

interface NextConfig {
  readonly serverExternalPackages?: string[]
  readonly outputFileTracingExcludes?: Record<string, string[]>
  readonly rewrites?: () => Promise<unknown>
  readonly [key: string]: unknown
}

export function withHolo<TConfig extends NextConfig>(nextConfig: TConfig = {} as TConfig): TConfig {
  const existingExternal = nextConfig.serverExternalPackages ?? []
  const mergedExternal = [
    ...new Set([...HOLO_SERVER_EXTERNAL_PACKAGES, ...existingExternal]),
  ]

  const existingExcludes = nextConfig.outputFileTracingExcludes ?? {}
  const existingGlobalExcludes = existingExcludes['/*'] ?? []
  const mergedExcludes = {
    ...existingExcludes,
    '/*': [...new Set(['./next.config.ts', './next.config.mjs', ...existingGlobalExcludes])],
  }

  const userRewrites = nextConfig.rewrites

  return {
    ...nextConfig,
    serverExternalPackages: mergedExternal,
    outputFileTracingExcludes: mergedExcludes,
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
