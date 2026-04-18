import { loadConfigDirectory, type NormalizedHoloSecurityConfig } from '@holo-js/config'
import { writeLine } from './io'
import { resolveProjectPackageImportSpecifier } from './project'
import type { IoStreams } from './cli-types'

type SecurityRedisAdapter = {
  connect(): Promise<void>
  close(): Promise<void>
}

type SecurityCliModule = {
  configureSecurityRuntime(options?: {
    readonly config: NormalizedHoloSecurityConfig
    readonly rateLimitStore?: unknown
  }): void
  resetSecurityRuntime(): void
  createRateLimitStoreFromConfig(
    config: NormalizedHoloSecurityConfig,
    options?: {
      readonly projectRoot?: string
      readonly redisAdapter?: unknown
    },
  ): {
    clear(key: string): Promise<boolean>
    clearByPrefix(prefix: string): Promise<number>
    clearAll(): Promise<number>
    hit(key: string, options: { readonly maxAttempts: number, readonly decaySeconds: number }): Promise<unknown>
  }
  clearRateLimit(options: { readonly limiter?: string, readonly key?: string, readonly all?: boolean }): Promise<boolean | number>
}

type SecurityRedisAdapterModule = {
  createSecurityRedisAdapter(config: NormalizedHoloSecurityConfig['rateLimit']['redis']): SecurityRedisAdapter
}

export async function loadSecurityCliModule(projectRoot: string): Promise<SecurityCliModule> {
  const specifier = resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/security')

  try {
    return await import(specifier) as SecurityCliModule
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to load @holo-js/security from ${projectRoot}. Install it with "holo install security". ${details}`,
    )
  }
}

export async function runRateLimitClearCommand(
  io: IoStreams,
  projectRoot: string,
  options: {
    readonly limiter?: string
    readonly key?: string
    readonly all?: boolean
  },
  dependencies: {
    readonly loadSecurityModule?: (projectRoot: string) => Promise<SecurityCliModule>
    readonly loadConfig?: (projectRoot: string) => Promise<{ security: NormalizedHoloSecurityConfig }>
    readonly loadRedisAdapter?: (projectRoot: string) => Promise<{
      createSecurityRedisAdapter(config: NormalizedHoloSecurityConfig['rateLimit']['redis']): SecurityRedisAdapter
    }>
  } = {},
): Promise<void> {
  const loadSecurityModule = dependencies.loadSecurityModule ?? loadSecurityCliModule
  const loadConfig = dependencies.loadConfig ?? (async (root: string) => {
    const loaded = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })
    return { security: loaded.security }
  })
  const loadRedisAdapter = dependencies.loadRedisAdapter ?? (async (root: string) => {
    return await import(resolveProjectPackageImportSpecifier(root, '@holo-js/security/drivers/redis-adapter')) as SecurityRedisAdapterModule
  })

  const { security: securityConfig } = await loadConfig(projectRoot)
  const securityModule = await loadSecurityModule(projectRoot)
  const driver = securityConfig.rateLimit.driver

  if (driver === 'memory') {
    throw new Error('[security] The memory rate-limit driver is process-local and cannot be cleared meaningfully from the CLI.')
  }

  let redisAdapter: SecurityRedisAdapter | undefined

  if (driver === 'redis') {
    const { createSecurityRedisAdapter } = await loadRedisAdapter(projectRoot)
    redisAdapter = createSecurityRedisAdapter(securityConfig.rateLimit.redis) as SecurityRedisAdapter
  }

  try {
    await redisAdapter?.connect()

    const rateLimitStoreOptions = redisAdapter
      ? { projectRoot, redisAdapter: redisAdapter as unknown }
      : { projectRoot }

    const rateLimitStore = securityModule.createRateLimitStoreFromConfig(securityConfig, rateLimitStoreOptions)

    securityModule.configureSecurityRuntime({
      config: securityConfig,
      rateLimitStore,
    })

    const cleared = await securityModule.clearRateLimit(options)
    const count = typeof cleared === 'boolean' ? (cleared ? 1 : 0) : cleared
    writeLine(io.stdout, `[security] Cleared ${count} rate-limit bucket(s).`)
  } finally {
    await redisAdapter?.close()
    securityModule.resetSecurityRuntime()
  }
}
