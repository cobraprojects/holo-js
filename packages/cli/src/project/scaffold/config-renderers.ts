import { appendFile, mkdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { holoStorageDefaults } from '@holo-js/config'
import {
  AUTH_CONFIG_FILE_NAMES,
  BROADCAST_CONFIG_FILE_NAMES,
  REDIS_CONFIG_FILE_NAMES,
  SUPPORTED_AUTH_SOCIAL_PROVIDERS,
  type SupportedCacheInstallerDriver,
  type SupportedQueueInstallerDriver,
  pathExists,
} from '../shared'
import {
  detectProjectFrameworkFromPackageJson,
  readPackageJsonDependencyState,
} from './dependencies'
import type {
  AuthInstallFeatures,
  ConfigModuleFormat,
} from './types'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from '../runtime'

export function renderStorageConfig(): string {
  return [
    'import { defineStorageConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineStorageConfig({',
    `  defaultDisk: env('STORAGE_DEFAULT_DISK', '${holoStorageDefaults.defaultDisk}'),`,
    `  routePrefix: env('STORAGE_ROUTE_PREFIX', '${holoStorageDefaults.routePrefix}'),`,
    '  disks: {',
    '    local: {',
    '      driver: \'local\',',
    '      root: \'./storage/app\',',
    '    },',
    '    public: {',
    '      driver: \'public\',',
    '      root: \'./storage/app/public\',',
    '      visibility: \'public\',',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderMediaConfig(): string {
  return [
    'import { defineMediaConfig } from \'@holo-js/config\'',
    '',
    'export default defineMediaConfig({})',
    '',
  ].join('\n')
}

export function renderQueueConfig(
  options: {
    readonly driver?: SupportedQueueInstallerDriver
    readonly defaultDatabaseConnection?: string
  } = {},
): string {
  const driver = options.driver ?? 'sync'
  const defaultDatabaseConnection = options.defaultDatabaseConnection?.trim() || 'default'

  if (driver === 'redis') {
    return [
      'import { defineQueueConfig, env } from \'@holo-js/config\'',
      '',
      'export default defineQueueConfig({',
      '  default: \'redis\',',
      '  failed: false,',
      '  connections: {',
      '    redis: {',
      '      driver: \'redis\',',
      '      connection: \'default\',',
      '      queue: \'default\',',
      '      retryAfter: 90,',
      '      blockFor: 5,',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  if (driver === 'database') {
    return [
      'import { defineQueueConfig } from \'@holo-js/config\'',
      '',
      'export default defineQueueConfig({',
      '  default: \'database\',',
      '  failed: {',
      '    driver: \'database\',',
      `    connection: '${defaultDatabaseConnection}',`,
      '    table: \'failed_jobs\',',
      '  },',
      '  connections: {',
      '    database: {',
      '      driver: \'database\',',
      `      connection: '${defaultDatabaseConnection}',`,
      '      table: \'jobs\',',
      '      queue: \'default\',',
      '      retryAfter: 90,',
      '      sleep: 1,',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  return [
    'import { defineQueueConfig } from \'@holo-js/config\'',
    '',
    'export default defineQueueConfig({',
    '  default: \'sync\',',
    '  failed: false,',
    '  connections: {',
    '    sync: {',
    '      driver: \'sync\',',
    '      queue: \'default\',',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderCacheConfig(
  driver: SupportedCacheInstallerDriver = 'file',
  defaultDatabaseConnection = 'default',
  defaultRedisConnection = 'default',
): string {
  const lines = [
    'import { defineCacheConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineCacheConfig({',
    `  default: '${driver}',`,
    '  prefix: env(\'CACHE_PREFIX\', \'\'),',
    '  drivers: {',
    '    file: {',
    '      driver: \'file\',',
    '      path: \'./storage/framework/cache/data\',',
    '    },',
    '    memory: {',
    '      driver: \'memory\',',
    '      maxEntries: 1000,',
    '    },',
  ]

  if (driver === 'redis') {
    lines.push(
      '    redis: {',
      '      driver: \'redis\',',
      `      connection: '${defaultRedisConnection}',`,
      '      prefix: \'cache:\',',
      '    },',
    )
  }

  if (driver === 'database') {
    lines.push(
      '    database: {',
      '      driver: \'database\',',
      `      connection: '${defaultDatabaseConnection}',`,
      '      table: \'cache\',',
      '      lockTable: \'cache_locks\',',
      '    },',
    )
  }

  lines.push(
    '  },',
    '})',
    '',
  )

  return lines.join('\n')
}

export function renderRedisConfig(): string {
  return [
    'import { defineRedisConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineRedisConfig({',
    '  default: \'default\',',
    '  connections: {',
    '    default: {',
    '      url: env(\'REDIS_URL\') || undefined,',
    '      host: env(\'REDIS_HOST\', \'127.0.0.1\'),',
    '      port: env(\'REDIS_PORT\', 6379),',
    '      username: env(\'REDIS_USERNAME\'),',
    '      password: env(\'REDIS_PASSWORD\'),',
    '      db: env(\'REDIS_DB\', 0),',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export async function ensureRedisConfigFile(projectRoot: string): Promise<boolean> {
  const redisConfigPath = await resolveFirstExistingPath(projectRoot, REDIS_CONFIG_FILE_NAMES) ?? resolve(projectRoot, 'config/redis.ts')
  const redisConfigExists = await pathExists(redisConfigPath)

  if (!redisConfigExists) {
    await writeTextFile(redisConfigPath, renderRedisConfig())
  }

  return !redisConfigExists
}

export function renderNotificationsConfig(): string {
  return [
    'import { defineNotificationsConfig } from \'@holo-js/config\'',
    '',
    'export default defineNotificationsConfig({',
    '  table: \'notifications\',',
    '  queue: {',
    '    afterCommit: false,',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderMailConfig(): string {
  return [
    'import { defineMailConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineMailConfig({',
    '  default: env(\'MAIL_MAILER\', \'preview\'),',
    '  from: {',
    '    email: env(\'MAIL_FROM_ADDRESS\', \'hello@app.test\'),',
    '    name: env(\'MAIL_FROM_NAME\', \'Holo App\'),',
    '  },',
    '  preview: {',
    '    allowedEnvironments: [\'development\'],',
    '  },',
    '  mailers: {',
    '    preview: {',
    '      driver: \'preview\',',
    '    },',
    '    log: {',
    '      driver: \'log\',',
    '    },',
    '    fake: {',
    '      driver: \'fake\',',
    '    },',
    '    smtp: {',
    '      driver: \'smtp\',',
    '      host: env(\'MAIL_HOST\', \'127.0.0.1\'),',
    '      port: env(\'MAIL_PORT\', 1025),',
    '      secure: env(\'MAIL_SECURE\', false),',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderSecurityConfig(): string {
  return [
    `import { defineSecurityConfig, limit } from '@holo-js/security'`,
    '',
    'export default defineSecurityConfig({',
    '  csrf: {',
    '    enabled: true,',
    '    field: \'_token\',',
    '    header: \'X-CSRF-TOKEN\',',
    '    cookie: \'XSRF-TOKEN\',',
    '    except: [],',
    '  },',
    '  rateLimit: {',
    '    driver: \'file\',',
    '    file: {',
    '      path: \'./storage/framework/rate-limits\',',
    '    },',
    '    redis: {',
    '      connection: \'default\',',
    '      prefix: \'holo:rate-limit:\',',
    '    },',
    '    limiters: {',
    '      login: limit.perMinute(5).define(),',
    '      register: limit.perHour(10).define(),',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export async function ensureRateLimitStorageIgnore(projectRoot: string): Promise<void> {
  const rateLimitRoot = resolve(projectRoot, 'storage/framework/rate-limits')
  const ignorePath = resolve(rateLimitRoot, '.gitignore')
  await mkdir(rateLimitRoot, { recursive: true })

  if (!(await pathExists(ignorePath))) {
    await writeTextFile(ignorePath, '*\n!.gitignore\n')
    return
  }

  const currentContents = (await readTextFile(ignorePath)) ?? ''
  const existingLines = new Set(currentContents.split(/\r?\n/))
  const missingLines = [
    '*',
    '!.gitignore',
  ].filter(line => !existingLines.has(line))

  if (missingLines.length === 0) {
    return
  }

  await appendFile(
    ignorePath,
    `${currentContents.length > 0 && !currentContents.endsWith('\n') ? '\n' : ''}${missingLines.join('\n')}\n`,
    'utf8',
  )
}

export function renderBroadcastConfig(
  moduleFormat: ConfigModuleFormat,
  includeAuthEndpoint: boolean,
  useTypeScriptSyntax: boolean,
): string {
  const renderBroadcastScheme = (): string => {
    return useTypeScriptSyntax
      ? "env('BROADCAST_SCHEME') === 'https' ? 'https' : 'http'"
      : "(process.env.BROADCAST_SCHEME === 'https' ? 'https' : 'http')"
  }

  if (moduleFormat === 'cjs') {
    return [
      'const { defineBroadcastConfig, env } = require(\'@holo-js/config\')',
      '',
      `const broadcastScheme = ${renderBroadcastScheme()}`,
      '',
      'module.exports = defineBroadcastConfig({',
      '  default: env(\'BROADCAST_CONNECTION\', \'holo\'),',
      '  connections: {',
      '    holo: {',
      '      driver: \'holo\',',
      '      appId: env(\'BROADCAST_APP_ID\', \'app-id\'),',
      '      key: env(\'BROADCAST_APP_KEY\', \'app-key\'),',
      '      secret: env(\'BROADCAST_APP_SECRET\', \'app-secret\'),',
      '      options: {',
      '        host: env(\'BROADCAST_HOST\', \'127.0.0.1\'),',
      '        port: env(\'BROADCAST_PORT\', 8080),',
      '        scheme: broadcastScheme,',
      '        useTLS: broadcastScheme === \'https\',',
      '      },',
      ...(includeAuthEndpoint
        ? [
            '      clientOptions: {',
            '        authEndpoint: `${env(\'APP_URL\', \'http://localhost:3000\')}/broadcasting/auth`,',
            '      },',
          ]
        : []),
      '    },',
      '    log: {',
      '      driver: \'log\',',
      '    },',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  return [
    'import { defineBroadcastConfig, env } from \'@holo-js/config\'',
    '',
    `const broadcastScheme = ${renderBroadcastScheme()}`,
    '',
    'export default defineBroadcastConfig({',
    '  default: env(\'BROADCAST_CONNECTION\', \'holo\'),',
    '  connections: {',
    '    holo: {',
    '      driver: \'holo\',',
    '      appId: env(\'BROADCAST_APP_ID\', \'app-id\'),',
    '      key: env(\'BROADCAST_APP_KEY\', \'app-key\'),',
    '      secret: env(\'BROADCAST_APP_SECRET\', \'app-secret\'),',
    '      options: {',
    '        host: env(\'BROADCAST_HOST\', \'127.0.0.1\'),',
    '        port: env(\'BROADCAST_PORT\', 8080),',
    '        scheme: broadcastScheme,',
    '        useTLS: broadcastScheme === \'https\',',
    '      },',
    ...(includeAuthEndpoint
      ? [
          '      clientOptions: {',
          '        authEndpoint: `${env(\'APP_URL\', \'http://localhost:3000\')}/broadcasting/auth`,',
          '      },',
        ]
      : []),
    '    },',
    '    log: {',
    '      driver: \'log\',',
    '    },',
    '    null: {',
    '      driver: \'null\',',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function stripBroadcastAuthEndpointBlock(value: string): string {
  return value.replace(
    /(^|\n)\s*clientOptions:\s*\{\n\s*authEndpoint:\s*.*,\n\s*\},/m,
    '',
  )
}

export function injectBroadcastAuthEndpoint(value: string): string | undefined {
  if (value.includes('authEndpoint:')) {
    return value
  }

  const nextValue = value.replace(
    /(holo:\s*\{[\s\S]*?options:\s*\{[\s\S]*?\n)([ \t]*)\},/m,
    (_match, prefix: string, indent: string) => {
      return [
        `${prefix}${indent}},`,
        `${indent}clientOptions: {`,
        `${indent}  authEndpoint: \`\${env('APP_URL', 'http://localhost:3000')}/broadcasting/auth\`,`,
        `${indent}},`,
      ].join('\n')
    },
  )

  return nextValue === value ? undefined : nextValue
}

function canSafelyRewriteBroadcastConfig(
  currentContents: string,
  moduleFormat: ConfigModuleFormat,
  useTypeScriptSyntax: boolean,
): boolean {
  return stripBroadcastAuthEndpointBlock(currentContents) === stripBroadcastAuthEndpointBlock(
    renderBroadcastConfig(moduleFormat, false, useTypeScriptSyntax),
  )
}

export function resolveBroadcastConfigTargetPath(
  projectRoot: string,
  manifestPath: string,
  moduleFormat: ConfigModuleFormat,
): string {
  const extension = extname(manifestPath)
  const targetExtension = extension === '.cjs' || extension === '.cts' || extension === '.mjs' || extension === '.mts'
    ? extension
    : moduleFormat === 'cjs'
      ? '.cjs'
      : (extension === '.ts' || extension === '.js' ? extension : '.ts')

  return resolve(projectRoot, `config/broadcast${targetExtension}`)
}

export function renderBroadcastEnvFiles(): { env: readonly string[], example: readonly string[] } {
  const env = [
    'BROADCAST_CONNECTION=holo',
  ]
  const example = [
    'BROADCAST_CONNECTION=holo',
    'BROADCAST_APP_ID=',
    'BROADCAST_APP_KEY=',
    'BROADCAST_APP_SECRET=',
  ]

  return {
    env,
    example,
  }
}

function renderNextBroadcastAuthRoute(): string {
  return [
    'import { renderBroadcastAuthResponse } from \'@holo-js/broadcast/auth\'',
    'import { holo } from \'@/server/holo\'',
    '',
    'export async function POST(request: Request) {',
    '  const app = await holo.getApp()',
    '  const auth = await holo.getAuth()',
    '',
    '  return await renderBroadcastAuthResponse(request, {',
    '    resolveUser: async () => await auth?.user(),',
    '    channelAuth: {',
    '      registry: {',
    '        projectRoot: app.projectRoot,',
    '        channels: app.registry?.channels ?? [],',
    '      },',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderNuxtBroadcastAuthRoute(): string {
  return [
    'import { defineEventHandler, getHeaders, getRequestURL, readRawBody } from \'h3\'',
    'import { renderBroadcastAuthResponse } from \'@holo-js/broadcast/auth\'',
    'import { holo } from \'#imports\'',
    '',
    'export default defineEventHandler(async (event) => {',
    '  const app = await holo.getApp()',
    '  const auth = await holo.getAuth()',
    '  const headers = new Headers()',
    '  for (const [key, value] of Object.entries(getHeaders(event))) {',
    '    if (typeof value === \'string\') {',
    '      headers.set(key, value)',
    '    }',
    '  }',
    '  const request = new Request(getRequestURL(event), {',
    '    method: event.method,',
    '    headers,',
    '    body: await readRawBody(event),',
    '  })',
    '',
    '  return await renderBroadcastAuthResponse(request, {',
    '    resolveUser: async () => await auth?.user(),',
    '    channelAuth: {',
    '      registry: {',
    '        projectRoot: app.projectRoot,',
    '        channels: app.registry?.channels ?? [],',
    '      },',
    '    },',
    '  })',
    '})',
    '',
  ].join('\n')
}

function renderSvelteBroadcastAuthRoute(): string {
  return [
    'import { renderBroadcastAuthResponse } from \'@holo-js/broadcast/auth\'',
    'import { holo } from \'$lib/server/holo\'',
    '',
    'export async function POST({ request }: { request: Request }) {',
    '  const app = await holo.getApp()',
    '  const auth = await holo.getAuth()',
    '',
    '  return await renderBroadcastAuthResponse(request, {',
    '    resolveUser: async () => await auth?.user(),',
    '    channelAuth: {',
    '      registry: {',
    '        projectRoot: app.projectRoot,',
    '        channels: app.registry?.channels ?? [],',
    '      },',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n')
}

export async function syncBroadcastAuthSupportAfterAuthInstall(projectRoot: string): Promise<{
  readonly updatedBroadcastConfig: boolean
  readonly createdBroadcastAuthRoute: boolean
}> {
  const { dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const framework = detectProjectFrameworkFromPackageJson(dependencies, devDependencies)
  const canCreateBroadcastAuthRoute = framework === 'next' || framework === 'nuxt' || framework === 'sveltekit'
  const authConfigPath = await resolveFirstExistingPath(projectRoot, AUTH_CONFIG_FILE_NAMES)
  const broadcastConfigPath = await resolveFirstExistingPath(projectRoot, BROADCAST_CONFIG_FILE_NAMES)
  if (!authConfigPath || !broadcastConfigPath || !canCreateBroadcastAuthRoute) {
    return {
      updatedBroadcastConfig: false,
      createdBroadcastAuthRoute: false,
    }
  }

  const currentBroadcastConfig = (await readTextFile(broadcastConfigPath))!
  let updatedBroadcastConfig = false
  let createdBroadcastAuthRoute = false
  if (!currentBroadcastConfig.includes('authEndpoint:')) {
    const broadcastConfigModuleFormat = resolveConfigModuleFormat(broadcastConfigPath, currentBroadcastConfig)
    const broadcastConfigIsTypeScript = ['.ts', '.mts', '.cts'].includes(extname(broadcastConfigPath))
    const rewrittenBroadcastConfig = canSafelyRewriteBroadcastConfig(
      currentBroadcastConfig,
      broadcastConfigModuleFormat,
      broadcastConfigIsTypeScript,
    )
      ? renderBroadcastConfig(broadcastConfigModuleFormat, true, broadcastConfigIsTypeScript)
      : injectBroadcastAuthEndpoint(currentBroadcastConfig)
    if (rewrittenBroadcastConfig) {
      await writeTextFile(
        broadcastConfigPath,
        rewrittenBroadcastConfig,
      )
      updatedBroadcastConfig = true
    }
  }

  if (framework === 'next') {
    const authRoutePath = resolve(projectRoot, 'app/broadcasting/auth/route.ts')
    if (!(await pathExists(authRoutePath))) {
      await writeTextFile(authRoutePath, renderNextBroadcastAuthRoute())
      createdBroadcastAuthRoute = true
    }
    return {
      updatedBroadcastConfig,
      createdBroadcastAuthRoute,
    }
  }

  if (framework === 'nuxt') {
    const authRoutePath = resolve(projectRoot, 'server/routes/broadcasting/auth.post.ts')
    if (!(await pathExists(authRoutePath))) {
      await writeTextFile(authRoutePath, renderNuxtBroadcastAuthRoute())
      createdBroadcastAuthRoute = true
    }
    return {
      updatedBroadcastConfig,
      createdBroadcastAuthRoute,
    }
  }

  if (framework === 'sveltekit') {
    const authRoutePath = resolve(projectRoot, 'src/routes/broadcasting/auth/+server.ts')
    if (!(await pathExists(authRoutePath))) {
      await writeTextFile(authRoutePath, renderSvelteBroadcastAuthRoute())
      createdBroadcastAuthRoute = true
    }
  }

  return {
    updatedBroadcastConfig,
    createdBroadcastAuthRoute,
  }
}

export function renderSessionConfig(defaultDatabaseConnection = 'default'): string {
  return [
    'import { defineSessionConfig, env } from \'@holo-js/config\'',
    '',
    "const sessionSameSite = env('SESSION_SAME_SITE') === 'strict'",
    "  ? 'strict'",
    "  : env('SESSION_SAME_SITE') === 'none'",
    "    ? 'none'",
    "    : 'lax'",
    '',
    'export default defineSessionConfig({',
    '  driver: env(\'SESSION_DRIVER\', \'file\'),',
    '  stores: {',
    '    database: {',
    '      driver: \'database\',',
    `      connection: env('SESSION_CONNECTION', '${defaultDatabaseConnection}'),`,
    '      table: \'sessions\',',
    '    },',
    '    file: {',
    '      driver: \'file\',',
    '      path: \'./storage/framework/sessions\',',
    '    },',
    '  },',
    '  cookie: {',
    '    name: env(\'SESSION_COOKIE\', \'holo_session\'),',
    '    path: env(\'SESSION_PATH\', \'/\'),',
    '    domain: env(\'SESSION_DOMAIN\'),',
    '    secure: env(\'SESSION_SECURE\', false),',
    '    httpOnly: true,',
    '    sameSite: sessionSameSite,',
    '  },',
    '  idleTimeout: env(\'SESSION_IDLE_TIMEOUT\', 120),',
    '  absoluteLifetime: env(\'SESSION_LIFETIME\', 120),',
    '  rememberMeLifetime: env(\'SESSION_REMEMBER_ME_LIFETIME\', 43200),',
    '})',
    '',
  ].join('\n')
}

export function renderAuthConfig(
  features: AuthInstallFeatures = {},
  moduleFormat: ConfigModuleFormat = 'esm',
): string {
  const envValue = (name: string, fallback?: string): string => {
    if (moduleFormat === 'cjs') {
      return typeof fallback === 'string'
        ? `process.env.${name} || ${JSON.stringify(fallback)}`
        : `process.env.${name}`
    }

    return typeof fallback === 'string'
      ? `env('${name}', ${JSON.stringify(fallback)})`
      : `env('${name}')`
  }
  const socialEnabled = features.social === true || (features.socialProviders?.length ?? 0) > 0
  const socialProviders = features.socialProviders && features.socialProviders.length > 0
    ? features.socialProviders
    : socialEnabled
      ? ['google']
      : []
  const lines = [
    moduleFormat === 'cjs'
      ? 'module.exports = {'
      : 'import { defineAuthConfig, env } from \'@holo-js/config\'',
    '',
    ...(moduleFormat === 'cjs' ? [] : ['export default defineAuthConfig({']),
    '  defaults: {',
    '    guard: \'web\',',
    '    passwords: \'users\',',
    '  },',
    '  guards: {',
    '    web: {',
    '      driver: \'session\',',
    '      provider: \'users\',',
    '    },',
    '    // admin: {',
    '    //   driver: \'session\',',
    '    //   provider: \'admins\',',
    '    // },',
    '  },',
    '  providers: {',
    '    users: {',
    '      model: \'User\',',
    '      identifiers: [\'email\'],',
    '    },',
    '    // admins: {',
    '    //   model: \'Admin\',',
    '    //   identifiers: [\'email\'],',
    '    // },',
    '  },',
    '  passwords: {',
    '    users: {',
    '      provider: \'users\',',
    '      table: \'password_reset_tokens\',',
    '      expire: 60,',
    '      throttle: 60,',
    '    },',
    '  },',
    '  emailVerification: {',
    '    required: false,',
    '  },',
    '  personalAccessTokens: {',
    '    defaultAbilities: [],',
    '  },',
    `  socialEncryptionKey: ${envValue('AUTH_SOCIAL_ENCRYPTION_KEY')},`,
  ]

  if (socialProviders.length > 0) {
    lines.push('  social: {')
    for (const provider of socialProviders) {
      const upper = provider.toUpperCase()
      const defaultScopes = provider === 'google'
        ? ['openid', 'email', 'profile']
        : provider === 'github'
          ? ['read:user', 'user:email']
          : provider === 'discord'
            ? ['identify', 'email']
            : provider === 'facebook'
              ? ['email', 'public_profile']
              : provider === 'apple'
                ? ['name', 'email']
                : ['openid', 'profile', 'email']
      lines.push(
        `    ${provider}: {`,
        `      clientId: ${envValue(`AUTH_${upper}_CLIENT_ID`)},`,
        `      clientSecret: ${envValue(`AUTH_${upper}_CLIENT_SECRET`)},`,
        `      redirectUri: ${envValue(`AUTH_${upper}_REDIRECT_URI`)},`,
        `      scopes: [${defaultScopes.map(scope => `'${scope}'`).join(', ')}],`,
        '    },',
      )
    }
    lines.push('  },')
  }

  if (features.workos) {
    lines.push(
      '  workos: {',
      '    dashboard: {',
      `      clientId: ${envValue('WORKOS_CLIENT_ID')},`,
      `      apiKey: ${envValue('WORKOS_API_KEY')},`,
      `      cookiePassword: ${envValue('WORKOS_COOKIE_PASSWORD')},`,
      `      redirectUri: ${envValue('WORKOS_REDIRECT_URI')},`,
      `      sessionCookie: ${envValue('WORKOS_SESSION_COOKIE', 'wos-session')},`,
      '    },',
      '  },',
      '  // Add a dedicated guard and provider if WorkOS users should resolve through a different model.',
    )
  }

  if (features.clerk) {
    lines.push(
      '  clerk: {',
      '    app: {',
      `      publishableKey: ${envValue('CLERK_PUBLISHABLE_KEY')},`,
      `      secretKey: ${envValue('CLERK_SECRET_KEY')},`,
      `      jwtKey: ${envValue('CLERK_JWT_KEY')},`,
      `      apiUrl: ${envValue('CLERK_API_URL')},`,
      `      frontendApi: ${envValue('CLERK_FRONTEND_API')},`,
      `      sessionCookie: ${envValue('CLERK_SESSION_COOKIE', '__session')},`,
      '    },',
      '  },',
      '  // Add a dedicated guard and provider if Clerk users should resolve through a different model.',
    )
  }

  lines.push(moduleFormat === 'cjs' ? '}' : '})', '')
  return lines.join('\n')
}

export function authFeaturesRequireConfigUpdate(features: AuthInstallFeatures): boolean {
  return features.workos === true
    || features.clerk === true
    || features.social === true
    || (features.socialProviders?.length ?? 0) > 0
}

export function detectAuthInstallFeaturesFromConfig(contents: string): AuthInstallFeatures {
  const socialProviders = SUPPORTED_AUTH_SOCIAL_PROVIDERS.filter(provider => {
    const pattern = new RegExp(`\\b${provider}\\s*:\\s*\\{`)
    return pattern.test(contents)
  })

  return Object.freeze({
    ...(socialProviders.length > 0 ? { social: true, socialProviders } : {}),
    ...(contents.includes('  workos: {') ? { workos: true } : {}),
    ...(contents.includes('  clerk: {') ? { clerk: true } : {}),
  })
}

function mergeAuthInstallFeatures(
  current: AuthInstallFeatures,
  requested: AuthInstallFeatures,
): AuthInstallFeatures {
  const socialProviders = Array.from(new Set([
    ...(current.socialProviders ?? []),
    ...(requested.socialProviders ?? []),
  ]))

  return Object.freeze({
    ...(current.social === true || requested.social === true || socialProviders.length > 0
      ? { social: true }
      : {}),
    ...(socialProviders.length > 0 ? { socialProviders } : {}),
    ...(current.workos === true || requested.workos === true ? { workos: true } : {}),
    ...(current.clerk === true || requested.clerk === true ? { clerk: true } : {}),
  })
}

export function canSafelyRewriteAuthConfig(
  currentContents: string,
  currentFeatures: AuthInstallFeatures,
  moduleFormat: ConfigModuleFormat,
): boolean {
  const stripLegacyCurrentUserEndpoint = (value: string): string => value.replace(
    /(^|\n)\s*currentUserEndpoint:\s*\{\n\s*path:\s*.*,\n\s*\},/m,
    '',
  )

  return stripLegacyCurrentUserEndpoint(currentContents) === stripLegacyCurrentUserEndpoint(
    renderAuthConfig(currentFeatures, moduleFormat),
  )
}

export function resolveConfigModuleFormat(
  filePath: string | undefined,
  contents: string,
): ConfigModuleFormat {
  if (
    filePath?.endsWith('.cjs')
    || filePath?.endsWith('.cts')
    || contents.includes('module.exports =')
  ) {
    return 'cjs'
  }

  return 'esm'
}

export function mergeInstalledAuthFeatures(
  current: AuthInstallFeatures,
  requested: AuthInstallFeatures,
): AuthInstallFeatures {
  return mergeAuthInstallFeatures(current, requested)
}
