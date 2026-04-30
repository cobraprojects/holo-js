import type { SupportedDatabaseDriver } from '@holo-js/config'
import {
  createMigrationFileName,
} from '@holo-js/db'
import { relativeImportPath } from '../../templates'
import {
  normalizeScaffoldOptionalPackages,
  sanitizePackageName,
  type ProjectScaffoldOptions,
  type SupportedCacheInstallerDriver,
  type SupportedQueueInstallerDriver,
} from '../shared'
import {
  AUTH_MIGRATION_SLUGS,
  type AuthInstallFeatures,
  type AuthMigrationSlug,
  type ScaffoldedFile,
} from './types'

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

export function renderAuthUserModel(_generatedSchemaImportPath = '../db/schema.generated'): string {
  return [
    'import { defineModel } from \'@holo-js/db\'',
    '',
    'export default defineModel(\'users\', {',
    '  fillable: [\'name\', \'email\', \'password\', \'avatar\', \'email_verified_at\'],',
    '  hidden: [\'password\'],',
    '})',
    '',
  ].join('\n')
}

export function renderAuthorizationPoliciesReadme(): string {
  return [
    '# Authorization Policies',
    '',
    'Place policy files in this directory.',
    'Export `definePolicy(...)` definitions from `@holo-js/authorization`.',
    '',
  ].join('\n')
}

export function renderAuthorizationAbilitiesReadme(): string {
  return [
    '# Authorization Abilities',
    '',
    'Place ability files in this directory.',
    'Export `defineAbility(...)` definitions from `@holo-js/authorization`.',
    '',
  ].join('\n')
}

export function resolveAuthUserModelSchemaImportPath(
  userModelPath: string,
  generatedSchemaPath: string,
): string {
  return relativeImportPath(userModelPath, generatedSchemaPath)
}

export function renderAuthMigration(slug: AuthMigrationSlug): string {
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

export function createAuthMigrationFiles(date = new Date()): readonly ScaffoldedFile[] {
  return AUTH_MIGRATION_SLUGS.map((slug, index) => ({
    path: createMigrationFileName(slug, new Date(date.getTime() + (index * 1000))),
    contents: renderAuthMigration(slug),
  }))
}

export function renderNotificationsMigration(): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    '    await schema.createTable(\'notifications\', (table) => {',
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'type\').nullable()',
    '      table.string(\'notifiable_type\')',
    '      table.string(\'notifiable_id\')',
    '      table.json(\'data\').default({})',
    '      table.timestamp(\'read_at\').nullable()',
    '      table.timestamp(\'created_at\')',
    '      table.timestamp(\'updated_at\')',
    '      table.index([\'notifiable_type\', \'notifiable_id\'])',
    '      table.index([\'read_at\'])',
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    '    await schema.dropTable(\'notifications\')',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function createNotificationsMigrationFiles(date = new Date()): readonly ScaffoldedFile[] {
  return [{
    path: createMigrationFileName('create_notifications', date),
    contents: renderNotificationsMigration(),
  }]
}

export function renderScaffoldAppConfig(projectName: string): string {
  return [
    'import { defineAppConfig, env } from \'@holo-js/config\'',
    '',
    "const appEnv = env('APP_ENV') === 'production'",
    "  ? 'production'",
    "  : env('APP_ENV') === 'test'",
    "    ? 'test'",
    "    : 'development'",
    '',
    'export default defineAppConfig({',
    `  name: env('APP_NAME', ${JSON.stringify(projectName)}),`,
    '  key: env(\'APP_KEY\'),',
    '  url: env(\'APP_URL\', \'http://localhost:3000\'),',
    '  env: appEnv,',
    '  debug: env(\'APP_DEBUG\', true),',
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

export function renderScaffoldDatabaseConfig(
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

export function resolveDefaultDatabaseUrl(driver: SupportedDatabaseDriver): string | undefined {
  if (driver === 'sqlite') {
    return './storage/database.sqlite'
  }

  return undefined
}

export function renderScaffoldEnvFiles(
  options: Pick<ProjectScaffoldOptions, 'databaseDriver' | 'projectName' | 'storageDefaultDisk' | 'optionalPackages'>,
): { env: string, example: string } {
  const defaultDatabaseConnection = 'main'
  const baseLines = [
    'APP_NAME=',
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
  const cacheLines = normalizeScaffoldOptionalPackages(options.optionalPackages).includes('cache')
    ? [...renderCacheEnvFiles('file').env]
    : []
  const env = [...baseLines, ...driverLines, ...storageLines, ...authLines, ...cacheLines, ''].join('\n')
  const example = [
    '# Copy this file to .env and fill in your local values.',
    '# Supported layered env files: .env.local, .env.development, .env.production, .env.prod, .env.test',
    ...[...baseLines, ...driverLines, ...storageLines, ...authLines, ...cacheLines].map(line => `${line.split('=')[0]}=`),
    '',
  ].join('\n')

  return { env, example }
}

function renderRedisConnectionEnvFiles(): { env: readonly string[], example: readonly string[] } {
  return {
    env: [
      'REDIS_URL=',
      'REDIS_HOST=127.0.0.1',
      'REDIS_PORT=6379',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=0',
    ],
    example: [
      'REDIS_URL=',
      'REDIS_HOST=',
      'REDIS_PORT=',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=',
    ],
  }
}

export function renderQueueEnvFiles(
  driver: SupportedQueueInstallerDriver,
): { env: readonly string[], example: readonly string[] } {
  if (driver !== 'redis') {
    return {
      env: [],
      example: [],
    }
  }

  return renderRedisConnectionEnvFiles()
}

export function renderCacheEnvFiles(
  driver: SupportedCacheInstallerDriver,
): { env: readonly string[], example: readonly string[] } {
  if (driver === 'redis') {
    const redis = renderRedisConnectionEnvFiles()
    return {
      env: [
        'CACHE_PREFIX=',
        ...redis.env,
      ],
      example: [
        'CACHE_PREFIX=',
        ...redis.example,
      ],
    }
  }

  return {
    env: [
      'CACHE_PREFIX=',
    ],
    example: [
      'CACHE_PREFIX=',
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

export function renderEnvFileContents(segments: readonly string[]): string {
  const normalized = segments
    .map(segment => segment.replace(/\n+$/, ''))
    .filter(segment => segment.length > 0)

  return normalized.length > 0
    ? `${normalized.join('\n')}\n`
    : ''
}

export function normalizeScaffoldEnvSegments(segments: string): readonly string[] {
  return segments
    .split('\n')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
}

export function upsertEnvContents(
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
  const additionKeys = new Set<string>()
  const missingLines = additions.flatMap(line => {
    const normalizedLine = line.trim()
    if (normalizedLine.length === 0 || normalizedLine.startsWith('#')) {
      return []
    }

    const key = parseEnvKey(normalizedLine)
    if (!key || additionKeys.has(key) || existingKeys.has(key)) {
      return []
    }

    additionKeys.add(key)
    return [normalizedLine]
  })

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
