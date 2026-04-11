import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  loadConfigDirectory,
  holoStorageDefaults,
  type SupportedDatabaseDriver,
} from '@holo-js/config'
import {
  normalizeHoloProjectConfig,
  renderGeneratedSchemaPlaceholder,
  createMigrationFileName,
} from '@holo-js/db'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_PACKAGE_MANAGER_VERSIONS,
} from '../metadata'
import { loadProjectConfig, resolveGeneratedSchemaPath } from './config'
import {
  AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES,
  AUTH_CONFIG_FILE_NAMES,
  DB_DRIVER_PACKAGE_NAMES,
  QUEUE_CONFIG_FILE_NAMES,
  SESSION_CONFIG_FILE_NAMES,
  SUPPORTED_AUTH_SOCIAL_PROVIDERS,
  type AuthInstallResult,
  type EventsInstallResult,
  type ProjectScaffoldOptions,
  type QueueInstallResult,
  type SupportedAuthSocialProvider,
  type SupportedQueueInstallerDriver,
  type SupportedScaffoldPackageManager,
  isSupportedQueueInstallerDriver,
  normalizeScaffoldOptionalPackages,
  pathExists,
  sanitizePackageName,
} from './shared'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from './runtime'
import { relativeImportPath } from '../templates'

type ScaffoldedFile = {
  readonly path: string
  readonly contents: string
}

type AuthInstallFeatures = {
  readonly social?: boolean
  readonly socialProviders?: readonly SupportedAuthSocialProvider[]
  readonly workos?: boolean
  readonly clerk?: boolean
}

type ConfigModuleFormat = 'esm' | 'cjs'

const AUTH_MIGRATION_SLUGS = [
  'create_users',
  'create_sessions',
  'create_auth_identities',
  'create_personal_access_tokens',
  'create_password_reset_tokens',
  'create_email_verification_tokens',
] as const

type AuthMigrationSlug = typeof AUTH_MIGRATION_SLUGS[number]

function renderStorageConfig(): string {
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

function renderMediaConfig(): string {
  return [
    'import { defineMediaConfig } from \'@holo-js/config\'',
    '',
    'export default defineMediaConfig({})',
    '',
  ].join('\n')
}

function renderQueueConfig(
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
      '      queue: \'default\',',
      '      retryAfter: 90,',
      '      blockFor: 5,',
      '      redis: {',
      '        host: env(\'REDIS_HOST\', \'127.0.0.1\'),',
      '        port: env(\'REDIS_PORT\', 6379),',
      '        username: env(\'REDIS_USERNAME\'),',
      '        password: env(\'REDIS_PASSWORD\'),',
      '        db: env(\'REDIS_DB\', 0),',
      '      },',
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

function renderSessionConfig(defaultDatabaseConnection = 'default'): string {
  return [
    'import { defineSessionConfig, env } from \'@holo-js/config\'',
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
    '    secure: env<boolean>(\'SESSION_SECURE\', false),',
    '    httpOnly: true,',
    '    sameSite: env<\'lax\' | \'strict\' | \'none\'>(\'SESSION_SAME_SITE\', \'lax\'),',
    '  },',
    '  idleTimeout: env(\'SESSION_IDLE_TIMEOUT\', 120),',
    '  absoluteLifetime: env(\'SESSION_LIFETIME\', 120),',
    '  rememberMeLifetime: env(\'SESSION_REMEMBER_ME_LIFETIME\', 43200),',
    '})',
    '',
  ].join('\n')
}

function renderAuthConfig(
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

function authFeaturesRequireConfigUpdate(features: AuthInstallFeatures): boolean {
  return features.workos === true
    || features.clerk === true
    || features.social === true
    || (features.socialProviders?.length ?? 0) > 0
}

function detectAuthInstallFeaturesFromConfig(contents: string): AuthInstallFeatures {
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

function canSafelyRewriteAuthConfig(
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

function resolveConfigModuleFormat(
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

export function renderAuthEnvFiles(
  features: AuthInstallFeatures = {},
  defaultDatabaseConnection = 'default',
): { env: readonly string[], example: readonly string[] } {
  const socialEnabled = features.social === true || (features.socialProviders?.length ?? 0) > 0
  const socialProviders = features.socialProviders && features.socialProviders.length > 0
    ? features.socialProviders
    : socialEnabled
      ? ['google']
      : []
  const env = [
    'AUTH_SOCIAL_ENCRYPTION_KEY=',
    'SESSION_DRIVER=file',
    `SESSION_CONNECTION=${defaultDatabaseConnection}`,
    'SESSION_COOKIE=holo_session',
    'SESSION_PATH=/',
    'SESSION_DOMAIN=',
    'SESSION_SECURE=false',
    'SESSION_SAME_SITE=lax',
    'SESSION_IDLE_TIMEOUT=120',
    'SESSION_LIFETIME=120',
    'SESSION_REMEMBER_ME_LIFETIME=43200',
  ]

  for (const provider of socialProviders) {
    const upper = provider.toUpperCase()
    env.push(
      `AUTH_${upper}_CLIENT_ID=`,
      `AUTH_${upper}_CLIENT_SECRET=`,
      `AUTH_${upper}_REDIRECT_URI=`,
    )
  }

  if (features.workos) {
    env.push(
      'WORKOS_CLIENT_ID=',
      'WORKOS_API_KEY=',
      'WORKOS_COOKIE_PASSWORD=',
      'WORKOS_REDIRECT_URI=',
      'WORKOS_SESSION_COOKIE=wos-session',
    )
  }

  if (features.clerk) {
    env.push(
      'CLERK_PUBLISHABLE_KEY=',
      'CLERK_SECRET_KEY=',
      'CLERK_JWT_KEY=',
      'CLERK_API_URL=',
      'CLERK_FRONTEND_API=',
      'CLERK_SESSION_COOKIE=__session',
    )
  }

  return {
    env,
    example: env.map(line => `${line.split('=')[0]}=`),
  }
}

function renderAuthUserModel(generatedSchemaImportPath = '../db/schema.generated'): string {
  return [
    `import { tables as holoGeneratedTables } from '${generatedSchemaImportPath}'`,
    'import { defineModel, type TableDefinition } from \'@holo-js/db\'',
    '',
    'const holoModelTable = (holoGeneratedTables as Partial<Record<string, TableDefinition>>).users',
    'export const holoModelPendingSchema = typeof holoModelTable === \'undefined\'',
    '',
    'export default holoModelPendingSchema',
    '  ? undefined',
    '  : defineModel(holoModelTable, {',
    '      fillable: [\'name\', \'email\', \'password\', \'avatar\', \'email_verified_at\'],',
    '      hidden: [\'password\'],',
    '    })',
    '',
  ].join('\n')
}

function resolveAuthUserModelSchemaImportPath(
  userModelPath: string,
  generatedSchemaPath: string,
): string {
  return relativeImportPath(userModelPath, generatedSchemaPath)
}

function renderAuthMigration(slug: AuthMigrationSlug): string {
  switch (slug) {
    case 'create_users':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'users\', (table) => {',
        '      table.id()',
        '      table.string(\'name\')',
        '      table.string(\'email\').unique()',
        '      table.string(\'password\').nullable()',
        '      table.string(\'avatar\').nullable()',
        '      table.timestamp(\'email_verified_at\').nullable()',
        '      table.timestamps()',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'users\')',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'create_sessions':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'sessions\', (table) => {',
        '      table.string(\'id\').primaryKey()',
        '      table.string(\'store\').default(\'database\')',
        '      table.json(\'data\').default({})',
        '      table.timestamp(\'created_at\')',
        '      table.timestamp(\'last_activity_at\')',
        '      table.timestamp(\'expires_at\')',
        '      table.timestamp(\'invalidated_at\').nullable()',
        '      table.string(\'remember_token_hash\').nullable()',
        '      table.index([\'expires_at\'])',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'sessions\')',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'create_auth_identities':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'auth_identities\', (table) => {',
        '      table.id()',
        '      table.string(\'user_id\')',
        '      table.string(\'guard\').default(\'web\')',
        '      table.string(\'auth_provider\').default(\'users\')',
        '      table.string(\'provider\')',
        '      table.string(\'provider_user_id\')',
        '      table.string(\'email\').nullable()',
        '      table.boolean(\'email_verified\').default(false)',
        '      table.json(\'profile\').default({})',
        '      table.json(\'tokens\').default({})',
        '      table.timestamps()',
        '      table.index([\'user_id\'])',
        '      table.unique([\'provider\', \'provider_user_id\'], \'auth_identities_provider_user_unique\')',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'auth_identities\')',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'create_personal_access_tokens':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'personal_access_tokens\', (table) => {',
        '      table.uuid(\'id\').primaryKey()',
        '      table.string(\'provider\').default(\'users\')',
        '      table.string(\'user_id\')',
        '      table.string(\'name\')',
        '      table.string(\'token_hash\').unique()',
        '      table.json(\'abilities\').default([])',
        '      table.timestamp(\'last_used_at\').nullable()',
        '      table.timestamp(\'expires_at\').nullable()',
        '      table.timestamps()',
        '      table.index([\'provider\'])',
        '      table.index([\'user_id\'])',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'personal_access_tokens\')',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'create_password_reset_tokens':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'password_reset_tokens\', (table) => {',
        '      table.uuid(\'id\').primaryKey()',
        '      table.string(\'provider\').default(\'users\')',
        '      table.string(\'email\')',
        '      table.string(\'token_hash\')',
        '      table.timestamp(\'expires_at\')',
        '      table.timestamp(\'used_at\').nullable()',
        '      table.timestamps()',
        '      table.index([\'provider\'])',
        '      table.index([\'email\'])',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'password_reset_tokens\')',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'create_email_verification_tokens':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        '    await schema.createTable(\'email_verification_tokens\', (table) => {',
        '      table.uuid(\'id\').primaryKey()',
        '      table.string(\'provider\').default(\'users\')',
        '      table.string(\'user_id\')',
        '      table.string(\'email\')',
        '      table.string(\'token_hash\')',
        '      table.timestamp(\'expires_at\')',
        '      table.timestamp(\'used_at\').nullable()',
        '      table.timestamps()',
        '      table.index([\'provider\'])',
        '      table.index([\'user_id\'])',
        '      table.index([\'email\'])',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        '    await schema.dropTable(\'email_verification_tokens\')',
        '  },',
        '})',
        '',
      ].join('\n')
  }
}

function createAuthMigrationFiles(date = new Date()): readonly ScaffoldedFile[] {
  return AUTH_MIGRATION_SLUGS.map((slug, index) => ({
    path: createMigrationFileName(slug, new Date(date.getTime() + (index * 1000))),
    contents: renderAuthMigration(slug),
  }))
}

function renderScaffoldAppConfig(projectName: string): string {
  return [
    'import type { HoloAppEnv } from \'@holo-js/config\'',
    'import { defineAppConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineAppConfig({',
    `  name: env('APP_NAME', ${JSON.stringify(projectName)}),`,
    '  key: env(\'APP_KEY\'),',
    '  url: env(\'APP_URL\', \'http://localhost:3000\'),',
    '  env: env<HoloAppEnv>(\'APP_ENV\', \'development\'),',
    '  debug: env<boolean>(\'APP_DEBUG\', true),',
    '  paths: {',
    '    models: \'server/models\',',
    '    migrations: \'server/db/migrations\',',
    '    seeders: \'server/db/seeders\',',
    '    commands: \'server/commands\',',
    '    jobs: \'server/jobs\',',
    '    events: \'server/events\',',
    '    listeners: \'server/listeners\',',
    '    generatedSchema: \'server/db/schema.generated.ts\',',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldDatabaseConfig(
  options: Pick<ProjectScaffoldOptions, 'databaseDriver' | 'projectName'>,
): string {
  const packageName = sanitizePackageName(options.projectName) || 'holo-app'

  if (options.databaseDriver === 'sqlite') {
    return [
      'import { defineDatabaseConfig, env } from \'@holo-js/config\'',
      '',
      'export default defineDatabaseConfig({',
      '  defaultConnection: \'main\',',
      '  connections: {',
      '    main: {',
      '      driver: \'sqlite\',',
      '      url: env(\'DB_URL\', \'./storage/database.sqlite\'),',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  const port = options.databaseDriver === 'mysql' ? '3306' : '5432'
  const username = options.databaseDriver === 'mysql' ? 'root' : 'postgres'
  const schemaLine = options.databaseDriver === 'postgres'
    ? '      schema: env(\'DB_SCHEMA\', \'public\'),'
    : undefined

  return [
    'import { defineDatabaseConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineDatabaseConfig({',
    '  defaultConnection: \'main\',',
    '  connections: {',
    '    main: {',
    `      driver: '${options.databaseDriver}',`,
    '      host: env(\'DB_HOST\', \'127.0.0.1\'),',
    `      port: env('DB_PORT', '${port}'),`,
    `      username: env('DB_USERNAME', '${username}'),`,
    '      password: env(\'DB_PASSWORD\'),',
    `      database: env('DB_DATABASE', '${packageName}'),`,
    ...(schemaLine ? [schemaLine] : []),
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldEnvFiles(
  options: Pick<ProjectScaffoldOptions, 'databaseDriver' | 'projectName' | 'storageDefaultDisk' | 'optionalPackages'>,
): { env: string, example: string } {
  const defaultDatabaseConnection = 'main'
  const baseLines = [
    `APP_NAME=${JSON.stringify(options.projectName)}`,
    'APP_KEY=',
    'APP_URL=http://localhost:3000',
    'APP_ENV=development',
    'APP_DEBUG=true',
    `DB_DRIVER=${options.databaseDriver}`,
  ]
  const driverLines = options.databaseDriver === 'sqlite'
    ? [
        `DB_URL=${resolveDefaultDatabaseUrl(options.databaseDriver)}`,
      ]
    : [
        'DB_HOST=127.0.0.1',
        `DB_PORT=${options.databaseDriver === 'mysql' ? '3306' : '5432'}`,
        `DB_USERNAME=${options.databaseDriver === 'mysql' ? 'root' : 'postgres'}`,
        'DB_PASSWORD=',
        `DB_DATABASE=${sanitizePackageName(options.projectName) || 'holo_app'}`,
        ...(options.databaseDriver === 'postgres' ? ['DB_SCHEMA=public'] : []),
      ]
  const storageLines = normalizeScaffoldOptionalPackages(options.optionalPackages).includes('storage')
    ? [
        `STORAGE_DEFAULT_DISK=${options.storageDefaultDisk}`,
        'STORAGE_ROUTE_PREFIX=/storage',
      ]
    : []
  const authLines = normalizeScaffoldOptionalPackages(options.optionalPackages).includes('auth')
    ? [...renderAuthEnvFiles({}, defaultDatabaseConnection).env]
    : []
  const env = [...baseLines, ...driverLines, ...storageLines, ...authLines, ''].join('\n')
  const example = [
    '# Copy this file to .env and fill in your local values.',
    '# Supported layered env files: .env.local, .env.development, .env.production, .env.prod, .env.test',
    ...[...baseLines, ...driverLines, ...storageLines, ...authLines].map(line => `${line.split('=')[0]}=`),
    '',
  ].join('\n')

  return { env, example }
}

function renderQueueEnvFiles(
  driver: SupportedQueueInstallerDriver,
): { env: readonly string[], example: readonly string[] } {
  if (driver !== 'redis') {
    return {
      env: [],
      example: [],
    }
  }

  return {
    env: [
      'REDIS_HOST=127.0.0.1',
      'REDIS_PORT=6379',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=0',
    ],
    example: [
      'REDIS_HOST=',
      'REDIS_PORT=',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=',
    ],
  }
}

function parseEnvKey(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined
  }

  const normalized = trimmed.startsWith('export ')
    ? trimmed.slice(7).trim()
    : trimmed
  const separatorIndex = normalized.indexOf('=')
  if (separatorIndex <= 0) {
    return undefined
  }

  return normalized.slice(0, separatorIndex).trim()
}

function upsertEnvContents(
  existingContents: string | undefined,
  additions: readonly string[],
): { readonly contents?: string, readonly changed: boolean } {
  if (additions.length === 0) {
    return {
      contents: existingContents,
      changed: false,
    }
  }

  const nextLines = existingContents
    ? existingContents.replace(/\r\n/g, '\n').split('\n')
    : []
  const existingKeys = new Set(nextLines.map(parseEnvKey).filter((value): value is string => typeof value === 'string'))
  const missingLines = additions.filter(line => !existingKeys.has(line.slice(0, line.indexOf('=')).trim()))

  if (missingLines.length === 0) {
    return {
      contents: existingContents,
      changed: false,
    }
  }

  if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== '') {
    nextLines.push('')
  }

  nextLines.push(...missingLines)

  return {
    contents: `${nextLines.join('\n').replace(/\n*$/, '')}\n`,
    changed: true,
  }
}

function normalizeDependencyMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, dependencyVersion]) => typeof dependencyVersion === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

async function readPackageJsonDependencyState(projectRoot: string): Promise<{
  packageJsonPath: string
  parsed: Record<string, unknown>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}> {
  const packageJsonPath = resolve(projectRoot, 'package.json')
  const existing = await readTextFile(packageJsonPath)
  if (!existing) {
    throw new Error(`Missing package.json in ${projectRoot}.`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid package.json in ${projectRoot}.`)
  }

  return {
    packageJsonPath,
    parsed,
    dependencies: normalizeDependencyMap(parsed.dependencies),
    devDependencies: normalizeDependencyMap(parsed.devDependencies),
  }
}

async function writePackageJsonDependencyState(
  packageJsonPath: string,
  parsed: Record<string, unknown>,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): Promise<void> {
  parsed.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )

  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = Object.fromEntries(
      Object.entries(devDependencies).sort(([left], [right]) => left.localeCompare(right)),
    )
  } else {
    delete parsed.devDependencies
  }

  await writeTextFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`)
}

function hasLoadedConfigFile(
  loadedFiles: readonly string[],
  configName: string,
): boolean {
  return loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
}

function inferDatabaseDriverFromUrl(value: string | undefined): SupportedDatabaseDriver | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) {
    return 'postgres'
  }

  if (normalized.startsWith('mysql://') || normalized.startsWith('mysql2://')) {
    return 'mysql'
  }

  if (
    normalized === ':memory:'
    || normalized.startsWith('file:')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.endsWith('.db')
    || normalized.endsWith('.sqlite')
    || normalized.endsWith('.sqlite3')
  ) {
    return 'sqlite'
  }

  return undefined
}

function inferConnectionDriver(
  connection: {
    driver?: string
    url?: string
    filename?: string
  } | string,
): SupportedDatabaseDriver | undefined {
  if (typeof connection === 'string') {
    return inferDatabaseDriverFromUrl(connection)
  }

  const explicitDriver = connection.driver
  if (explicitDriver === 'sqlite' || explicitDriver === 'postgres' || explicitDriver === 'mysql') {
    return explicitDriver
  }

  return inferDatabaseDriverFromUrl(connection.url ?? connection.filename)
}

export async function syncManagedDriverDependencies(projectRoot: string): Promise<boolean> {
  const loaded = await loadConfigDirectory(projectRoot, {
    preferCache: false,
    processEnv: process.env,
  })
  const queueConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'queue')
  const storageConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'storage')
  const requiredPackages = new Set<string>()

  for (const connection of Object.values(loaded.database.connections)) {
    const inferredDriver = inferConnectionDriver(connection)
    if (inferredDriver) {
      requiredPackages.add(DB_DRIVER_PACKAGE_NAMES[inferredDriver])
    }
  }

  if (queueConfigured) {
    requiredPackages.add('@holo-js/queue')

    const queueConnections = Object.values(loaded.queue.connections)
    if (queueConnections.some(connection => connection.driver === 'redis')) {
      requiredPackages.add('@holo-js/queue-redis')
    }

    if (
      queueConnections.some(connection => connection.driver === 'database')
      || loaded.queue.failed !== false
    ) {
      requiredPackages.add('@holo-js/queue-db')
    }
  }

  if (storageConfigured) {
    requiredPackages.add('@holo-js/storage')

    if (Object.values(loaded.storage.disks).some(disk => disk.driver === 's3')) {
      requiredPackages.add('@holo-js/storage-s3')
    }
  }

  const {
    packageJsonPath,
    parsed,
    dependencies,
    devDependencies,
  } = await readPackageJsonDependencyState(projectRoot)

  let changed = false
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const removableManagedPackages = new Set<string>([
    ...Object.values(DB_DRIVER_PACKAGE_NAMES),
    '@holo-js/queue-db',
    '@holo-js/queue-redis',
    '@holo-js/storage-s3',
  ])

  for (const packageName of requiredPackages) {
    if (dependencies[packageName] !== nextVersion || typeof devDependencies[packageName] !== 'undefined') {
      dependencies[packageName] = nextVersion
      delete devDependencies[packageName]
      changed = true
    }
  }

  for (const packageName of removableManagedPackages) {
    if (requiredPackages.has(packageName)) {
      continue
    }

    if (typeof dependencies[packageName] !== 'undefined' || typeof devDependencies[packageName] !== 'undefined') {
      delete dependencies[packageName]
      delete devDependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertQueuePackageDependency(
  projectRoot: string,
  driver?: SupportedQueueInstallerDriver,
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, QUEUE_CONFIG_FILE_NAMES)
  const loadedQueueConfig = queueConfigPath
    ? loadConfigDirectory(projectRoot, {
        preferCache: false,
        processEnv: process.env,
      }).then(config => config.queue)
        /* v8 ignore next -- existing malformed queue config falls back to explicit driver handling in installer tests */
        .catch(() => undefined)
    /* v8 ignore next -- exercised by dependency-sync tests, but v8 does not attribute the ternary fallback line */
    : Promise.resolve(undefined)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const nextEsbuildVersion = ESBUILD_PACKAGE_VERSION
  const queueConfig = typeof driver === 'undefined'
    ? await loadedQueueConfig
    : undefined
  const resolvedQueueDriver = driver && driver !== 'sync'
    ? driver
    : queueConfig?.connections[queueConfig.default]?.driver ?? driver
  const requiresQueueDb = resolvedQueueDriver === 'database'
    || (queueConfig?.failed ?? false) !== false
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'database')
  const requiresQueueRedis = resolvedQueueDriver === 'redis'
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'redis')
  const currentVersion = dependencies['@holo-js/queue']
  const currentQueueDbVersion = dependencies['@holo-js/queue-db']
  const currentQueueRedisVersion = dependencies['@holo-js/queue-redis']
  const currentDevVersion = devDependencies['@holo-js/queue']
  const currentDevQueueDbVersion = devDependencies['@holo-js/queue-db']
  const currentDevQueueRedisVersion = devDependencies['@holo-js/queue-redis']
  const currentEsbuildVersion = dependencies.esbuild
  const currentDevEsbuildVersion = devDependencies.esbuild

  if (
    currentVersion === nextVersion
    && (requiresQueueDb ? currentQueueDbVersion === nextVersion : typeof currentQueueDbVersion === 'undefined')
    && (requiresQueueRedis ? currentQueueRedisVersion === nextVersion : typeof currentQueueRedisVersion === 'undefined')
    && typeof currentDevVersion === 'undefined'
    && typeof currentDevQueueDbVersion === 'undefined'
    && typeof currentDevQueueRedisVersion === 'undefined'
    && currentEsbuildVersion === nextEsbuildVersion
    && typeof currentDevEsbuildVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/queue'] = nextVersion
  if (requiresQueueDb) {
    dependencies['@holo-js/queue-db'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-db']
  }
  if (requiresQueueRedis) {
    dependencies['@holo-js/queue-redis'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-redis']
  }
  dependencies.esbuild = nextEsbuildVersion
  delete devDependencies['@holo-js/queue']
  delete devDependencies['@holo-js/queue-db']
  delete devDependencies['@holo-js/queue-redis']
  delete devDependencies.esbuild

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertEventsPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/events']
  const currentDevVersion = devDependencies['@holo-js/events']

  if (
    currentVersion === nextVersion
    && typeof currentDevVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/events'] = nextVersion
  delete devDependencies['@holo-js/events']

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertAuthPackageDependencies(
  projectRoot: string,
  features: AuthInstallFeatures = {},
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const socialEnabled = features.social === true || (features.socialProviders?.length ?? 0) > 0
  const requestedPackages = {
    '@holo-js/auth': true,
    '@holo-js/session': true,
    '@holo-js/auth-social': socialEnabled,
    '@holo-js/auth-workos': features.workos === true,
    '@holo-js/auth-clerk': features.clerk === true,
  } as const
  const requestedSocialProviders = new Set(features.socialProviders ?? (socialEnabled ? ['google'] : []))

  let changed = false

  for (const [packageName, enabled] of Object.entries(requestedPackages)) {
    const currentDependency = dependencies[packageName]
    const currentDevDependency = devDependencies[packageName]

    if (enabled) {
      if (currentDependency !== nextVersion || typeof currentDevDependency !== 'undefined') {
        dependencies[packageName] = nextVersion
        delete devDependencies[packageName]
        changed = true
      }
      continue
    }

    if (typeof currentDevDependency !== 'undefined') {
      delete devDependencies[packageName]
      changed = true
    }
  }

  for (const [providerName, packageName] of Object.entries(AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES)) {
    const enabled = requestedSocialProviders.has(providerName as SupportedAuthSocialProvider)
    const currentDependency = dependencies[packageName]
    const currentDevDependency = devDependencies[packageName]

    if (enabled) {
      if (currentDependency !== nextVersion || typeof currentDevDependency !== 'undefined') {
        dependencies[packageName] = nextVersion
        delete devDependencies[packageName]
        changed = true
      }
      continue
    }

    if (typeof currentDevDependency !== 'undefined') {
      delete devDependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function resolveExistingModelPath(modelsRoot: string, modelName: string): Promise<string | undefined> {
  const supportedExtensions = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs']

  for (const extension of supportedExtensions) {
    const candidate = resolve(modelsRoot, `${modelName}${extension}`)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return undefined
}

async function resolveExistingAuthMigrationFiles(migrationsRoot: string): Promise<Map<AuthMigrationSlug, string>> {
  const entries = await readdir(migrationsRoot).catch(() => [] as string[])
  const resolved = new Map<AuthMigrationSlug, string>()

  for (const entry of entries) {
    for (const slug of AUTH_MIGRATION_SLUGS) {
      if (
        entry.endsWith(`_${slug}.ts`)
        || entry.endsWith(`_${slug}.mts`)
        || entry.endsWith(`_${slug}.js`)
        || entry.endsWith(`_${slug}.mjs`)
        || entry.endsWith(`_${slug}.cts`)
        || entry.endsWith(`_${slug}.cjs`)
      ) {
        resolved.set(slug, resolve(migrationsRoot, entry))
      }
    }
  }

  return resolved
}

export async function installAuthIntoProject(
  projectRoot: string,
  features: AuthInstallFeatures = {},
): Promise<AuthInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const modelsRoot = resolve(projectRoot, project.config.paths.models)
  const migrationsRoot = resolve(projectRoot, project.config.paths.migrations)
  /* v8 ignore next -- normalized project configs always resolve a database default connection; this fallback only protects malformed external state. */
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const authConfigPath = await resolveFirstExistingPath(projectRoot, AUTH_CONFIG_FILE_NAMES)
  const sessionConfigPath = await resolveFirstExistingPath(projectRoot, SESSION_CONFIG_FILE_NAMES)
  const userModelPath = await resolveExistingModelPath(modelsRoot, 'User')
  const existingMigrationFiles = await resolveExistingAuthMigrationFiles(migrationsRoot)
  const hasAllAuthMigrations = AUTH_MIGRATION_SLUGS.every(slug => existingMigrationFiles.has(slug))
  const existingAuthArtifacts = [
    authConfigPath,
    userModelPath,
    ...AUTH_MIGRATION_SLUGS.map(slug => existingMigrationFiles.get(slug)),
  ].filter((value): value is string => typeof value === 'string')

  if (authConfigPath && userModelPath && hasAllAuthMigrations) {
    const envPath = resolve(projectRoot, '.env')
    const envExamplePath = resolve(projectRoot, '.env.example')
    /* v8 ignore next -- authConfigPath was resolved from an existing file; undefined would require an external delete race. */
    const currentAuthConfig = (await readTextFile(authConfigPath)) ?? ''
    const currentAuthFeatures = detectAuthInstallFeaturesFromConfig(currentAuthConfig)
    const nextAuthFeatures = mergeAuthInstallFeatures(currentAuthFeatures, features)
    const authConfigModuleFormat = resolveConfigModuleFormat(authConfigPath, currentAuthConfig)
    const nextAuthConfig = renderAuthConfig(nextAuthFeatures, authConfigModuleFormat)
    const authEnvFiles = renderAuthEnvFiles(nextAuthFeatures, defaultDatabaseConnection)
    const nextEnv = upsertEnvContents(await readTextFile(envPath), authEnvFiles.env)
    const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), authEnvFiles.example)
    const authConfigChanged = authFeaturesRequireConfigUpdate(features) && currentAuthConfig !== nextAuthConfig

    if (authConfigChanged) {
      if (!canSafelyRewriteAuthConfig(currentAuthConfig, currentAuthFeatures, authConfigModuleFormat)) {
        throw new Error(
          `Auth support is already installed in ${projectRoot}, but ${authConfigPath} contains manual changes. `
          + 'Refusing to overwrite the existing auth config automatically.',
        )
      }
      await writeTextFile(authConfigPath, nextAuthConfig)
    }

    if (nextEnv.changed && typeof nextEnv.contents === 'string') {
      await writeTextFile(envPath, nextEnv.contents)
    }

    if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
      await writeTextFile(envExamplePath, nextEnvExample.contents)
    }

    return {
      updatedPackageJson: await upsertAuthPackageDependencies(projectRoot, nextAuthFeatures),
      createdAuthConfig: authConfigChanged,
      createdSessionConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: nextEnv.changed,
      updatedEnvExample: nextEnvExample.changed,
    }
  }

  const collisions = sessionConfigPath && existingAuthArtifacts.length === 0
    ? []
    : [
        ...existingAuthArtifacts,
        ...(sessionConfigPath && existingAuthArtifacts.length > 0 ? [sessionConfigPath] : []),
      ]

  if (collisions.length > 0) {
    throw new Error(
      `Auth support is partially installed. Refusing to overwrite existing files in ${projectRoot}: ${collisions.join(', ')}`,
    )
  }

  const authConfigTargetPath = resolve(projectRoot, 'config/auth.ts')
  const sessionConfigTargetPath = resolve(projectRoot, 'config/session.ts')
  const userModelTargetPath = resolve(modelsRoot, 'User.ts')
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, project.config)
  const migrationFiles = createAuthMigrationFiles()
  const authEnvFiles = renderAuthEnvFiles(features, defaultDatabaseConnection)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(modelsRoot, { recursive: true })
  await mkdir(migrationsRoot, { recursive: true })
  await writeTextFile(authConfigTargetPath, renderAuthConfig(features))
  if (!sessionConfigPath) {
    await writeTextFile(sessionConfigTargetPath, renderSessionConfig(defaultDatabaseConnection))
  }
  await writeTextFile(
    userModelTargetPath,
    renderAuthUserModel(resolveAuthUserModelSchemaImportPath(
      userModelTargetPath,
      generatedSchemaPath,
    )),
  )

  const createdMigrationFiles: string[] = []
  for (const migrationFile of migrationFiles) {
    const migrationPath = resolve(migrationsRoot, migrationFile.path)
    await writeTextFile(migrationPath, migrationFile.contents)
    createdMigrationFiles.push(migrationPath)
  }

  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), authEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), authEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    updatedPackageJson: await upsertAuthPackageDependencies(projectRoot, features),
    createdAuthConfig: true,
    createdSessionConfig: !sessionConfigPath,
    createdUserModel: true,
    createdMigrationFiles,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
  }
}

export async function installQueueIntoProject(
  projectRoot: string,
  options: {
    readonly driver?: SupportedQueueInstallerDriver
  } = {},
): Promise<QueueInstallResult> {
  const driver = options.driver ?? 'sync'
  if (!isSupportedQueueInstallerDriver(driver)) {
    throw new Error(`Unsupported queue driver: ${driver}.`)
  }

  const project = await loadProjectConfig(projectRoot)
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, QUEUE_CONFIG_FILE_NAMES) ?? resolve(projectRoot, 'config/queue.ts')
  const queueConfigExists = await pathExists(queueConfigPath)
  const jobsRoot = resolve(projectRoot, project.config.paths.jobs)
  const jobsDirectoryExists = await pathExists(jobsRoot)
  const queueEnvFiles = renderQueueEnvFiles(driver)

  if (!queueConfigExists) {
    await writeTextFile(queueConfigPath, renderQueueConfig({
      driver,
      defaultDatabaseConnection,
    }))
  }

  await mkdir(jobsRoot, { recursive: true })

  const updatedPackageJson = await upsertQueuePackageDependency(
    projectRoot,
    !queueConfigExists || driver !== 'sync' ? driver : undefined,
  )
  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), queueEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), queueEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    createdQueueConfig: !queueConfigExists,
    updatedPackageJson,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
    createdJobsDirectory: !jobsDirectoryExists,
  }
}

export async function installEventsIntoProject(
  projectRoot: string,
): Promise<EventsInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const eventsRoot = resolve(projectRoot, project.config.paths.events)
  const listenersRoot = resolve(projectRoot, project.config.paths.listeners)
  const eventsDirectoryExists = await pathExists(eventsRoot)
  const listenersDirectoryExists = await pathExists(listenersRoot)

  await mkdir(eventsRoot, { recursive: true })
  await mkdir(listenersRoot, { recursive: true })

  return {
    updatedPackageJson: await upsertEventsPackageDependency(projectRoot),
    createdEventsDirectory: !eventsDirectoryExists,
    createdListenersDirectory: !listenersDirectoryExists,
  }
}

function renderScaffoldGitignore(): string {
  return [
    'node_modules',
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.prod',
    '.env.test',
    '.holo-js/generated',
    '.holo-js/runtime',
    '.nuxt',
    '.output',
    '.next',
    '.svelte-kit',
    'coverage',
    'dist',
    '',
  ].join('\n')
}

function renderScaffoldTsconfig(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  if (options.framework === 'nuxt') {
    return `${JSON.stringify({
      extends: './.nuxt/tsconfig.json',
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }, null, 2)}\n`
  }

  if (options.framework === 'sveltekit') {
    return `${JSON.stringify({
      extends: './.svelte-kit/tsconfig.json',
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: [
        'src/**/*.ts',
        'src/**/*.svelte',
        'server/**/*.ts',
        'config/**/*.ts',
        '.holo-js/generated/**/*.ts',
        '.holo-js/generated/**/*.d.ts',
        'vite.config.ts',
      ],
    }, null, 2)}\n`
  }

  const include = ['next-env.d.ts', 'app/**/*.ts', 'app/**/*.tsx', 'server/**/*.ts', 'config/**/*.ts', '.holo-js/generated/**/*.ts', '.holo-js/generated/**/*.d.ts']

  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '.',
      jsx: 'preserve',
      paths: {
        '~/*': ['./*'],
        '@/*': ['./*'],
      },
    },
    include,
  }, null, 2)}\n`
}

function renderNuxtAppVue(projectName: string): string {
  return [
    '<template>',
    '  <main class="shell">',
    `    <h1>${projectName}</h1>`,
    '    <p>Nuxt renders the UI. Holo owns the backend runtime and canonical server directories.</p>',
    '  </main>',
    '</template>',
    '',
    '<style scoped>',
    '.shell {',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-content: center;',
    '  gap: 1rem;',
    '  padding: 3rem;',
    '  font-family: sans-serif;',
    '}',
    'h1 {',
    '  margin: 0;',
    '  font-size: clamp(2.5rem, 6vw, 4rem);',
    '}',
    'p {',
    '  margin: 0;',
    '  max-width: 40rem;',
    '  line-height: 1.6;',
    '}',
    '</style>',
    '',
  ].join('\n')
}

function renderNuxtConfig(): string {
  return [
    'export default defineNuxtConfig({',
    '  modules: [\'@holo-js/adapter-nuxt\'],',
    '  typescript: {',
    '    strict: true,',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHealthRoute(): string {
  return [
    'export default defineEventHandler(async () => {',
    '  const app = await holo.getApp()',
    '',
    '  return {',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  }',
    '})',
    '',
  ].join('\n')
}

function renderNextConfig(storageEnabled: boolean): string {
  if (!storageEnabled) {
    return [
      '/** @type {import(\'next\').NextConfig} */',
      'const nextConfig = {}',
      '',
      'export default nextConfig',
      '',
    ].join('\n')
  }

  return [
    'const storageRoutePrefix = (() => {',
    '  const raw = process.env.STORAGE_ROUTE_PREFIX?.trim() ?? \'/storage\'',
    '  if (!raw || raw === \'/\') {',
    '    return \'/storage\'',
    '  }',
    '',
    '  return `/${raw.replace(/^\\/+|\\/+$/g, \'\')}`',
    '})()',
    '',
    '/** @type {import(\'next\').NextConfig} */',
    'const nextConfig = {',
    '  async rewrites() {',
    '    if (storageRoutePrefix === \'/storage\') {',
    '      return []',
    '    }',
    '',
    '    return [',
    '      {',
    '        source: `${storageRoutePrefix}/:path*`,',
    '        destination: \'/storage/:path*\',',
    '      },',
    '    ]',
    '  },',
    '}',
    '',
    'export default nextConfig',
    '',
  ].join('\n')
}

function renderNextLayout(projectName: string): string {
  return [
    'import type { ReactNode } from \'react\'',
    '',
    'export const metadata = {',
    `  title: ${JSON.stringify(projectName)},`,
    '  description: \'Holo on Next.js\',',
    '}',
    '',
    'export default function RootLayout({ children }: { children: ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function renderNextPage(projectName: string): string {
  return [
    'export default function HomePage() {',
    '  return (',
    '    <main style={{ padding: \'3rem\', fontFamily: \'sans-serif\' }}>',
    `      <h1>${projectName}</h1>`,
    '      <p>Next.js handles rendering. Holo powers the backend runtime and discovered server resources.</p>',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function renderNextEnvDts(): string {
  return [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    '',
    '// Generated by Holo. Do not edit.',
    '',
  ].join('\n')
}

function renderNextHoloHelper(): string {
  return [
    'import { createNextHoloHelpers } from \'@holo-js/adapter-next\'',
    '',
    'export const holo = createNextHoloHelpers()',
    '',
  ].join('\n')
}

function renderPublicStorageHelper(): string {
  return [
    'import { readFile, realpath } from \'node:fs/promises\'',
    'import { extname, resolve, sep } from \'node:path\'',
    'import { normalizeModuleOptions, type RuntimeDiskConfig, type HoloStorageRuntimeConfig } from \'@holo-js/storage\'',
    'import type { NormalizedHoloStorageConfig } from \'@holo-js/config\'',
    '',
    'const NAMED_PUBLIC_DISK_ROUTE_SEGMENT = \'__holo\'',
    '',
    'type PublicLocalDisk = RuntimeDiskConfig & {',
    '  driver: \'local\' | \'public\'',
    '  visibility: \'public\'',
    '  root: string',
    '}',
    '',
    'type ResolvedPublicStorageRequest = {',
    '  disk: PublicLocalDisk',
    '  absolutePath: string',
    '}',
    '',
    'function normalizeRequestPath(value: string): string[] {',
    '  return value',
    '    .split(\'/\')',
    '    .map((segment) => {',
    '      const trimmed = segment.trim()',
    '      if (!trimmed) {',
    '        return trimmed',
    '      }',
    '',
    '      try {',
    '        return decodeURIComponent(trimmed)',
    '      } catch {',
    '        return trimmed',
      '      }',
    '    })',
    '    .filter(Boolean)',
    '}',
    '',
    'function isPublicLocalDisk(disk: RuntimeDiskConfig | undefined): disk is PublicLocalDisk {',
    '  return Boolean(disk && disk.visibility === \'public\' && disk.driver !== \'s3\' && typeof disk.root === \'string\')',
    '}',
    '',
    'function resolveAbsolutePath(projectRoot: string, disk: PublicLocalDisk, fileSegments: string[]): string | null {',
    '  const root = resolve(projectRoot, disk.root)',
    '  const absolutePath = resolve(root, ...fileSegments)',
    '  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {',
    '    return null',
    '  }',
    '',
    '  return absolutePath',
    '}',
    '',
    'function resolveContentType(absolutePath: string): string {',
    '  switch (extname(absolutePath).toLowerCase()) {',
    '    case \'.avif\': return \'image/avif\'',
    '    case \'.css\': return \'text/css; charset=utf-8\'',
    '    case \'.gif\': return \'image/gif\'',
    '    case \'.html\': return \'text/html; charset=utf-8\'',
    '    case \'.jpeg\':',
    '    case \'.jpg\': return \'image/jpeg\'',
    '    case \'.js\':',
    '    case \'.mjs\': return \'text/javascript; charset=utf-8\'',
    '    case \'.json\': return \'application/json; charset=utf-8\'',
    '    case \'.mp3\': return \'audio/mpeg\'',
    '    case \'.pdf\': return \'application/pdf\'',
    '    case \'.png\': return \'image/png\'',
    '    case \'.svg\': return \'image/svg+xml\'',
    '    case \'.txt\': return \'text/plain; charset=utf-8\'',
    '    case \'.webp\': return \'image/webp\'',
    '    case \'.woff\': return \'font/woff\'',
    '    case \'.woff2\': return \'font/woff2\'',
    '    default: return \'application/octet-stream\'',
    '  }',
    '}',
    '',
    'function createMissingFileResponse(): Response {',
    '  return new Response(\'Storage file not found.\', { status: 404 })',
    '}',
    '',
    'function resolveRouteSegments(routePath: string): string[] | null {',
    '  const segments = normalizeRequestPath(routePath)',
    '  if (segments.length === 0 || segments.includes(\'..\')) {',
    '    return null',
    '  }',
    '',
    '  return segments',
    '}',
    '',
    'function resolveDefaultPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {',
    '  const disk = isPublicLocalDisk(config.disks.public) ? config.disks.public : undefined',
    '  if (!disk) {',
    '    return null',
    '  }',
    '',
    '  const absolutePath = resolveAbsolutePath(projectRoot, disk, segments)',
    '  return absolutePath ? { disk, absolutePath } : null',
    '}',
    '',
    'function usesReservedNamedDiskNamespace(segments: string[]): boolean {',
    '  return segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT',
    '}',
    '',
    'function resolveNamedPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {',
    '  const namedPublicDisks = Object.values(config.disks).filter((disk): disk is PublicLocalDisk => isPublicLocalDisk(disk) && disk.name !== \'public\')',
    '  const usesReservedNamespace = segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT',
    '  const diskName = usesReservedNamespace ? segments[1] : segments[0]',
    '  const disk = diskName ? namedPublicDisks.find(candidate => candidate.name === diskName) : undefined',
    '  if (!disk) {',
    '    return null',
    '  }',
    '',
    '  const fileSegments = usesReservedNamespace ? segments.slice(2) : segments.slice(1)',
    '  if (fileSegments.length === 0) {',
    '    return null',
    '  }',
    '',
    '  const absolutePath = resolveAbsolutePath(projectRoot, disk, fileSegments)',
    '  return absolutePath ? { disk, absolutePath } : null',
    '}',
    '',
    'function resolvePublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, routePath: string): ResolvedPublicStorageRequest | null {',
    '  const segments = resolveRouteSegments(routePath)',
    '  if (!segments) {',
    '    return null',
    '  }',
    '',
    '  if (usesReservedNamedDiskNamespace(segments)) {',
    '    return resolveNamedPublicStorageRequest(projectRoot, config, segments) ?? resolveDefaultPublicStorageRequest(projectRoot, config, segments)',
    '  }',
    '',
    '  return resolveDefaultPublicStorageRequest(projectRoot, config, segments) ?? resolveNamedPublicStorageRequest(projectRoot, config, segments)',
    '}',
    '',
    'function resolveFallbackPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[], attemptedDiskName: string): ResolvedPublicStorageRequest | null {',
    '  if (usesReservedNamedDiskNamespace(segments)) {',
    '    return null',
    '  }',
    '',
    '  const candidates = [',
    '    resolveDefaultPublicStorageRequest(projectRoot, config, segments),',
    '    resolveNamedPublicStorageRequest(projectRoot, config, segments),',
    '  ]',
    '',
    '  return candidates.find(candidate => candidate && candidate.disk.name !== attemptedDiskName) ?? null',
    '}',
    '',
    'export async function createPublicStorageResponse(projectRoot: string, storageConfig: NormalizedHoloStorageConfig, request: Request): Promise<Response> {',
    '  const normalized = normalizeModuleOptions({',
    '    defaultDisk: storageConfig.defaultDisk,',
    '    routePrefix: storageConfig.routePrefix,',
    '    disks: storageConfig.disks,',
    '  })',
    '  const pathname = new URL(request.url).pathname',
    '  const routePath = pathname.startsWith(normalized.routePrefix) ? pathname.slice(normalized.routePrefix.length) : pathname',
    '  const segments = resolveRouteSegments(routePath)',
    '',
    '  if (!segments) {',
    '    return createMissingFileResponse()',
    '  }',
    '',
    '  const resolvedRequest = resolvePublicStorageRequest(projectRoot, normalized, routePath)',
    '  if (!resolvedRequest) {',
    '    return createMissingFileResponse()',
    '  }',
    '',
    '  const tryRead = async (entry: ResolvedPublicStorageRequest): Promise<Response | null> => {',
    '    try {',
    '      const resolvedRoot = await realpath(resolve(projectRoot, entry.disk.root))',
    '      const resolvedPath = await realpath(entry.absolutePath)',
    '      if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {',
    '        return null',
    '      }',
    '',
    '      const contents = await readFile(entry.absolutePath)',
    '      return new Response(contents, {',
    '        status: 200,',
    '        headers: { \'content-type\': resolveContentType(entry.absolutePath) },',
    '      })',
    '    } catch {',
    '      return null',
    '    }',
    '  }',
    '',
    '  const primary = await tryRead(resolvedRequest)',
    '  if (primary) {',
    '    return primary',
    '  }',
    '',
    '  const fallback = resolveFallbackPublicStorageRequest(projectRoot, normalized, segments, resolvedRequest.disk.name)',
    '  return fallback ? ((await tryRead(fallback)) ?? createMissingFileResponse()) : createMissingFileResponse()',
    '}',
    '',
  ].join('\n')
}

function renderNextHealthRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return Response.json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderNextStorageRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    'import { createPublicStorageResponse } from \'@/server/lib/public-storage\'',
    '',
    'export async function GET(request: Request) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteConfig(): string {
  return [
    'import adapter from \'@sveltejs/adapter-node\'',
    'import { vitePreprocess } from \'@sveltejs/vite-plugin-svelte\'',
    '',
    '/** @type {import(\'@sveltejs/kit\').Config} */',
    'const config = {',
    '  preprocess: vitePreprocess(),',
    '  kit: {',
    '    adapter: adapter(),',
    '  },',
    '}',
    '',
    'export default config',
    '',
  ].join('\n')
}

function renderSvelteHooksServer(): string {
  return [
    'import type { Handle } from \'@sveltejs/kit\'',
    'import { env } from \'$env/dynamic/private\'',
    '',
    'function normalizeStorageRoutePrefix(value: string | undefined): string {',
    '  const raw = value?.trim() ?? \'/storage\'',
    '  if (!raw || raw === \'/\') {',
    '    return \'/storage\'',
    '  }',
    '',
    '  return `/${raw.replace(/^\\/+|\\/+$/g, \'\')}`',
    '}',
    '',
    'export const handle: Handle = async ({ event, resolve }) => {',
    '  const storageRoutePrefix = normalizeStorageRoutePrefix(env.STORAGE_ROUTE_PREFIX)',
    '',
    '  if (storageRoutePrefix !== \'/storage\') {',
    '    const pathname = event.url.pathname',
    '    if (pathname === storageRoutePrefix || pathname.startsWith(`${storageRoutePrefix}/`)) {',
    '      event.url.pathname = `/storage${pathname.slice(storageRoutePrefix.length)}` || \'/storage\'',
    '    }',
    '  }',
    '',
    '  return resolve(event)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteViteConfig(storageEnabled: boolean): string {
  const externals = [
    '      \'@holo-js/adapter-sveltekit\',',
    '      \'@holo-js/config\',',
    '      \'@holo-js/core\',',
    '      \'@holo-js/db\',',
    ...(storageEnabled
      ? [
          '      \'@holo-js/storage\',',
          '      \'@holo-js/storage/runtime\',',
        ]
      : []),
    '      \'better-sqlite3\',',
  ]

  return [
    'import { sveltekit } from \'@sveltejs/kit/vite\'',
    'import { defineConfig } from \'vite\'',
    '',
    'export default defineConfig({',
    '  plugins: [sveltekit()],',
    '  ssr: {',
    '    external: [',
    ...externals,
    '    ],',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderSvelteAppHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    %sveltekit.head%',
    '  </head>',
    '  <body data-sveltekit-preload-data="hover">',
    '    <div style="display: contents">%sveltekit.body%</div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

function renderSveltePage(projectName: string): string {
  return [
    `<svelte:head><title>${projectName}</title></svelte:head>`,
    '',
    '<script lang="ts">',
    `  const projectName = ${JSON.stringify(projectName)}`,
    '</script>',
    '',
    '<main class="shell">',
    '  <h1>{projectName}</h1>',
    '  <p>SvelteKit owns rendering. Holo owns config, discovery, and backend runtime services.</p>',
    '</main>',
    '',
    '<style>',
    '  .shell {',
    '    min-height: 100vh;',
    '    display: grid;',
    '    place-content: center;',
    '    gap: 1rem;',
    '    padding: 3rem;',
    '    font-family: sans-serif;',
    '  }',
    '  h1 {',
    '    margin: 0;',
    '    font-size: clamp(2.5rem, 6vw, 4rem);',
    '  }',
    '  p {',
    '    margin: 0;',
    '    max-width: 40rem;',
    '    line-height: 1.6;',
    '  }',
    '</style>',
    '',
  ].join('\n')
}

function renderSvelteHoloHelper(): string {
  return [
    'import { createSvelteKitHoloHelpers } from \'@holo-js/adapter-sveltekit\'',
    '',
    'export const holo = createSvelteKitHoloHelpers()',
    '',
  ].join('\n')
}

function renderSvelteHealthRoute(): string {
  return [
    'import { json } from \'@sveltejs/kit\'',
    'import { holo } from \'$lib/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderSvelteStorageRoute(): string {
  return [
    'import { holo } from \'$lib/server/holo\'',
    'import { createPublicStorageResponse } from \'../../../../server/lib/public-storage\'',
    '',
    'export async function GET({ request }: { request: Request }) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

function renderFrameworkFiles(options: ProjectScaffoldOptions): readonly ScaffoldedFile[] {
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')

  if (options.framework === 'nuxt') {
    return [
      { path: 'app.vue', contents: renderNuxtAppVue(options.projectName) },
      { path: 'nuxt.config.ts', contents: renderNuxtConfig() },
      { path: 'server/api/holo/health.get.ts', contents: renderNuxtHealthRoute() },
    ]
  }

  if (options.framework === 'next') {
    return [
      { path: 'next.config.mjs', contents: renderNextConfig(storageEnabled) },
      { path: 'next-env.d.ts', contents: renderNextEnvDts() },
      { path: 'app/layout.tsx', contents: renderNextLayout(options.projectName) },
      { path: 'app/page.tsx', contents: renderNextPage(options.projectName) },
      { path: 'app/api/holo/health/route.ts', contents: renderNextHealthRoute() },
      ...(storageEnabled
        ? [
            { path: 'app/storage/[[...path]]/route.ts', contents: renderNextStorageRoute() },
            { path: 'server/lib/public-storage.ts', contents: renderPublicStorageHelper() },
          ]
        : []),
      { path: 'server/holo.ts', contents: renderNextHoloHelper() },
    ]
  }

  return [
    { path: 'svelte.config.js', contents: renderSvelteConfig() },
    { path: 'vite.config.ts', contents: renderSvelteViteConfig(storageEnabled) },
    ...(storageEnabled
      ? [{ path: 'src/hooks.server.ts', contents: renderSvelteHooksServer() }]
      : []),
    { path: 'src/app.html', contents: renderSvelteAppHtml() },
    { path: 'src/routes/+page.svelte', contents: renderSveltePage(options.projectName) },
    { path: 'src/routes/api/holo/+server.ts', contents: renderSvelteHealthRoute() },
    ...(storageEnabled
      ? [{ path: 'src/routes/storage/[...path]/+server.ts', contents: renderSvelteStorageRoute() }]
      : []),
    { path: 'src/lib/server/holo.ts', contents: renderSvelteHoloHelper() },
    ...(storageEnabled
      ? [{ path: 'server/lib/public-storage.ts', contents: renderPublicStorageHelper() }]
      : []),
  ]
}

function renderFrameworkRunner(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  const commandName = options.framework === 'nuxt'
    ? 'nuxi'
    : options.framework === 'next'
      ? 'next'
      : 'vite'
  return [
    'import { existsSync, readFileSync } from \'node:fs\'',
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { spawn } from \'node:child_process\'',
    '',
    'const mode = process.argv[2]',
    'const manifestPath = fileURLToPath(new URL(\'./project.json\', import.meta.url))',
    'const projectRoot = resolve(dirname(manifestPath), \'../..\')',
    'const manifest = JSON.parse(readFileSync(manifestPath, \'utf8\'))',
    'const framework = String(manifest.framework ?? \'\')',
    `const commandName = ${JSON.stringify(commandName)}`,
    'const commandArgs = mode === \'dev\'',
    '  ? [\'dev\']',
    '  : mode === \'build\'',
    '    ? [\'build\']',
    '    : undefined',
    '',
    'if (!commandArgs) {',
    '  console.error(`[holo] Unknown framework runner mode: ${String(mode)}`)',
    '  process.exit(1)',
    '}',
    '',
    'const binaryPath = resolve(',
    '  projectRoot,',
    '  \'node_modules\',',
    '  \'.bin\',',
    '  process.platform === \'win32\' ? `${commandName}.cmd` : commandName,',
    ')',
    '',
    'if (!existsSync(binaryPath)) {',
    '  console.error(`[holo] Missing framework binary "${commandName}" for "${framework}". Run your package manager install first.`)',
    '  process.exit(1)',
    '}',
    '',
    'const child = spawn(binaryPath, commandArgs, {',
    '  cwd: projectRoot,',
    '  env: process.env,',
    '  stdio: \'inherit\',',
    '})',
    '',
    'child.on(\'error\', (error) => {',
    '  console.error(error instanceof Error ? error.message : String(error))',
    '  process.exit(1)',
    '})',
    '',
    'child.on(\'close\', (code) => {',
    '  process.exit(code ?? 1)',
    '})',
    '',
  ].join('\n')
}

function resolvePackageManagerVersion(value: SupportedScaffoldPackageManager): string {
  return SCAFFOLD_PACKAGE_MANAGER_VERSIONS[value]
}

function resolveDefaultDatabaseUrl(driver: SupportedDatabaseDriver): string | undefined {
  if (driver === 'sqlite') {
    return './storage/database.sqlite'
  }

  return undefined
}

function renderScaffoldPackageJson(options: ProjectScaffoldOptions): string {
  const packageName = sanitizePackageName(options.projectName) || 'holo-app'
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const dependencies: Record<string, string> = {
    '@holo-js/cli': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/config': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/core': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/db': `^${HOLO_PACKAGE_VERSION}`,
    [DB_DRIVER_PACKAGE_NAMES[options.databaseDriver]]: `^${HOLO_PACKAGE_VERSION}`,
    esbuild: ESBUILD_PACKAGE_VERSION,
  }
  const devDependencies: Record<string, string> = {
    typescript: '^5.7.2',
    '@types/node': '^22.10.2',
  }

  if (options.framework === 'nuxt') {
    dependencies.nuxt = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
    dependencies['@holo-js/adapter-nuxt'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt
  }

  if (options.framework === 'next') {
    dependencies.next = SCAFFOLD_FRAMEWORK_VERSIONS.next
    dependencies.react = '^19.0.0'
    dependencies['react-dom'] = '^19.0.0'
    dependencies['@holo-js/adapter-next'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.next
    devDependencies['@types/react'] = '^19.0.0'
    devDependencies['@types/react-dom'] = '^19.0.0'
  }

  if (options.framework === 'sveltekit') {
    dependencies['@holo-js/adapter-sveltekit'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.sveltekit
    dependencies['@sveltejs/adapter-node'] = '^5.0.0'
    dependencies['@sveltejs/kit'] = SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit
    dependencies['@sveltejs/vite-plugin-svelte'] = '^4.0.0'
    dependencies.svelte = '^5.0.0'
    dependencies.vite = '^5.0.0'
  }

  if (optionalPackages.includes('storage')) {
    dependencies['@holo-js/storage'] = SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS[options.framework]['@holo-js/storage']
  }

  if (optionalPackages.includes('events')) {
    dependencies['@holo-js/events'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('queue')) {
    dependencies['@holo-js/queue'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('validation')) {
    dependencies['@holo-js/validation'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('forms')) {
    dependencies['@holo-js/forms'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('auth')) {
    dependencies['@holo-js/auth'] = `^${HOLO_PACKAGE_VERSION}`
    dependencies['@holo-js/session'] = `^${HOLO_PACKAGE_VERSION}`
  }

  return `${JSON.stringify({
    name: packageName,
    private: true,
    type: 'module',
    packageManager: resolvePackageManagerVersion(options.packageManager),
    scripts: {
      ...(options.framework === 'nuxt'
        ? { postinstall: 'nuxt prepare' }
        : {}),
      prepare: 'holo prepare',
      dev: 'holo dev',
      build: 'holo build',
      ['config:cache']: 'holo config:cache',
      ['config:clear']: 'holo config:clear',
      ['holo:dev']: 'node ./.holo-js/framework/run.mjs dev',
      ['holo:build']: 'node ./.holo-js/framework/run.mjs build',
    },
    dependencies,
    devDependencies,
  }, null, 2)}\n`
}

export async function scaffoldProject(
  projectRoot: string,
  options: ProjectScaffoldOptions,
): Promise<void> {
  const existingEntries = await readdir(projectRoot).catch(() => [] as string[])
  if (existingEntries.length > 0) {
    throw new Error(`Refusing to scaffold into a non-empty directory: ${projectRoot}`)
  }

  const { env, example } = renderScaffoldEnvFiles(options)
  const config = normalizeHoloProjectConfig()
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, config)
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')
  const queueEnabled = optionalPackages.includes('queue')
  const eventsEnabled = optionalPackages.includes('events')
  const authEnabled = optionalPackages.includes('auth')

  await mkdir(projectRoot, { recursive: true })
  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(resolve(projectRoot, '.holo-js', 'framework'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.models), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.commands), { recursive: true })
  if (queueEnabled) {
    await mkdir(resolve(projectRoot, config.paths.jobs), { recursive: true })
  }
  if (eventsEnabled) {
    await mkdir(resolve(projectRoot, config.paths.events), { recursive: true })
    await mkdir(resolve(projectRoot, config.paths.listeners), { recursive: true })
  }
  await mkdir(resolve(projectRoot, 'server/db/factories'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/migrations'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/seeders'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/schema'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.observers), { recursive: true })
  await mkdir(resolve(projectRoot, 'storage'), { recursive: true })
  if (storageEnabled) {
    await mkdir(resolve(projectRoot, 'storage/app/public'), { recursive: true })
  }

  await writeFile(resolve(projectRoot, 'package.json'), renderScaffoldPackageJson(options), 'utf8')
  await writeFile(resolve(projectRoot, '.gitignore'), renderScaffoldGitignore(), 'utf8')
  await writeFile(resolve(projectRoot, '.env'), env, 'utf8')
  await writeFile(resolve(projectRoot, '.env.example'), example, 'utf8')
  await writeFile(resolve(projectRoot, 'config/app.ts'), renderScaffoldAppConfig(options.projectName), 'utf8')
  await writeFile(resolve(projectRoot, 'config/database.ts'), renderScaffoldDatabaseConfig(options), 'utf8')
  if (queueEnabled) {
    await writeFile(resolve(projectRoot, 'config/queue.ts'), renderQueueConfig({
      driver: 'sync',
      defaultDatabaseConnection: 'main',
    }), 'utf8')
  }
  if (authEnabled) {
    await writeFile(resolve(projectRoot, 'config/auth.ts'), renderAuthConfig(), 'utf8')
    await writeFile(resolve(projectRoot, 'config/session.ts'), renderSessionConfig('main'), 'utf8')
    const userModelPath = resolve(projectRoot, config.paths.models, 'User.ts')
    await writeFile(
      userModelPath,
      renderAuthUserModel(resolveAuthUserModelSchemaImportPath(
        userModelPath,
        generatedSchemaPath,
      )),
      'utf8',
    )

    for (const migrationFile of createAuthMigrationFiles()) {
      await writeFile(resolve(projectRoot, config.paths.migrations, migrationFile.path), migrationFile.contents, 'utf8')
    }
  }
  if (storageEnabled) {
    await writeFile(resolve(projectRoot, 'config/storage.ts'), renderStorageConfig(), 'utf8')
  }
  await writeFile(resolve(projectRoot, '.holo-js/framework/run.mjs'), renderFrameworkRunner(options), 'utf8')
  await writeFile(resolve(projectRoot, '.holo-js/framework/project.json'), `${JSON.stringify(options, null, 2)}\n`, 'utf8')
  await writeFile(resolve(projectRoot, 'tsconfig.json'), renderScaffoldTsconfig(options), 'utf8')
  await writeFile(generatedSchemaPath, renderGeneratedSchemaPlaceholder(), 'utf8')

  for (const file of renderFrameworkFiles(options)) {
    await writeTextFile(resolve(projectRoot, file.path), file.contents)
  }

  if (options.databaseDriver === 'sqlite') {
    await writeFile(resolve(projectRoot, 'storage/database.sqlite'), '', 'utf8')
  }
}

export {
  authFeaturesRequireConfigUpdate,
  detectAuthInstallFeaturesFromConfig,
  hasLoadedConfigFile,
  inferConnectionDriver,
  inferDatabaseDriverFromUrl,
  isSupportedQueueInstallerDriver,
  renderAuthConfig,
  renderAuthMigration,
  renderAuthUserModel,
  renderSessionConfig,
  normalizeScaffoldOptionalPackages,
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderMediaConfig,
  renderQueueConfig,
  renderQueueEnvFiles,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldGitignore,
  renderScaffoldPackageJson,
  renderScaffoldTsconfig,
  renderScaffoldEnvFiles,
  renderStorageConfig,
  resolveDefaultDatabaseUrl,
  resolvePackageManagerVersion,
  sanitizePackageName,
  upsertAuthPackageDependencies,
  upsertEventsPackageDependency,
}
