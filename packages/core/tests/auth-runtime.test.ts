import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSchemaService, DB } from '@holo-js/db'
import { authRuntimeInternals } from '../../auth/src'
import { listFakeSentMails, resetFakeSentMails } from '@holo-js/mail'
import { configureNotificationsRuntime } from '@holo-js/notifications'
import { createHolo, holoRuntimeInternals, resetHoloRuntime } from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []
type VerificationTokenLike = {
  readonly id: string
  readonly plainTextToken: string
}
type SessionRecordLike = {
  readonly id: string
  readonly store: string
  readonly rememberTokenHash?: string
}

async function createProject(options: {
  session?: 'file' | 'database' | false
  auth?: boolean
  mail?: boolean
  notifications?: boolean
  social?: boolean
  socialEncryptionKey?: string
  workos?: boolean
  clerk?: boolean
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-auth-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Core Auth App',
  env: 'development',
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    events: 'server/events',
    listeners: 'server/listeners',
    generatedSchema: 'server/db/schema.generated.ts',
  },
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${configEntry}

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

  if (options.session !== false && (options.session || options.auth)) {
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${configEntry}

export default defineSessionConfig({
  driver: '${options.session === 'database' ? 'database' : 'file'}',
  stores: {
    ${options.session === 'database'
      ? `database: {
      driver: 'database',
      connection: 'main',
      table: 'sessions',
    },`
      : `file: {
      driver: 'file',
      path: './storage/framework/sessions',
    },`}
  },
})
`, 'utf8')
  }

  if (options.auth) {
    await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  ${options.socialEncryptionKey ? `socialEncryptionKey: '${options.socialEncryptionKey}',` : ''}
  ${options.social ? `social: {
    google: {
      clientId: 'client',
      encryptTokens: ${options.socialEncryptionKey ? 'true' : 'false'},
    },
  },` : ''}
  ${options.workos ? `workos: {
    dashboard: {
      clientId: 'client',
    },
  },` : ''}
  ${options.clerk ? `clerk: {
    app: {
      publishableKey: 'pk_test',
    },
  },` : ''}
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()

export default {
  async find(id) {
    return users.get(id)
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return undefined
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')
  }

  if (options.notifications) {
    await writeFile(join(root, 'config/notifications.ts'), `
import { defineNotificationsConfig } from ${configEntry}

export default defineNotificationsConfig({
  table: 'notifications',
})
`, 'utf8')
  }

  if (options.mail) {
    await writeFile(join(root, 'config/mail.ts'), `
import { defineMailConfig } from ${configEntry}

export default defineMailConfig({
  default: 'fake',
  from: {
    email: 'noreply@app.test',
    name: 'Core Auth App',
  },
  mailers: {
    fake: {
      driver: 'fake',
    },
  },
})
`, 'utf8')
  }

  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  resetFakeSentMails()
  await resetHoloRuntime()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/core auth/session boot', () => {
  it('leaves auth and session undefined when the project does not configure them', async () => {
    const root = await createProject()
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    expect(runtime.session).toBeUndefined()
    expect(runtime.auth).toBeUndefined()
  })

  it('boots session and auth runtimes when config and packages are present', async () => {
    const root = await createProject({
      auth: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    expect(runtime.session).toBeDefined()
    expect(runtime.auth).toBeDefined()
    expect(typeof runtime.session?.sessionCookie('example')).toBe('string')
    expect(typeof runtime.auth?.check).toBe('function')
    await expect(runtime.auth?.currentAccessToken()).resolves.toBeNull()
    await expect(runtime.auth?.logoutAll()).resolves.toEqual([
      {
        guard: 'web',
        cookies: [],
      },
    ])
  })

  it('bridges auth delivery through notifications when notifications are installed', async () => {
    const root = await createProject({
      auth: true,
      notifications: true,
      mail: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const record = {
      ...(users.get(Number(id)) ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const mailer = {
      send: vi.fn(async () => {}),
    }

    await runtime.initialize()
    configureNotificationsRuntime({
      config: runtime.loadedConfig.notifications,
      store: holoRuntimeInternals.createCoreNotificationStore(runtime.loadedConfig),
      mailer,
    })
    await createSchemaService(DB.connection()).createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['user_id'])
      table.index(['email'])
    })
    await createSchemaService(DB.connection()).createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['email'])
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })

    const verificationToken = await runtime.auth?.verification.create(registered!) as VerificationTokenLike | undefined
    await runtime.auth?.passwords.request('ava@example.com')

    expect(mailer.send).toHaveBeenCalledTimes(2)
    expect(mailer.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      subject: 'Verify your email address',
      lines: expect.arrayContaining([
        'Use this token to verify your email address:',
        verificationToken?.plainTextToken,
      ]),
      metadata: {
        provider: 'users',
        tokenId: verificationToken?.id,
      },
    }), expect.objectContaining({
      channel: 'email',
      route: {
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))
    expect(mailer.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      subject: 'Reset your password',
      lines: expect.arrayContaining([
        'Use this token to reset your password:',
      ]),
      metadata: expect.objectContaining({
        provider: 'users',
      }),
    }), expect.objectContaining({
      channel: 'email',
      route: 'ava@example.com',
      anonymous: true,
    }))
  })

  it('bridges auth delivery through notifications without requiring mail to be installed', async () => {
    const root = await createProject({
      auth: true,
      notifications: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const record = {
      ...(users.get(Number(id)) ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const mailer = {
      send: vi.fn(async () => {}),
    }

    configureNotificationsRuntime({
      mailer,
    })
    await runtime.initialize()
    await createSchemaService(DB.connection()).createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['user_id'])
      table.index(['email'])
    })
    await createSchemaService(DB.connection()).createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['email'])
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })

    const verificationToken = await runtime.auth?.verification.create(registered!) as VerificationTokenLike | undefined
    await runtime.auth?.passwords.request('ava@example.com')

    expect(mailer.send).toHaveBeenCalledTimes(2)
    expect(mailer.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      subject: 'Verify your email address',
      lines: expect.arrayContaining([
        'Use this token to verify your email address:',
        verificationToken?.plainTextToken,
      ]),
    }), expect.objectContaining({
      channel: 'email',
      route: {
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))
    expect(mailer.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      subject: 'Reset your password',
      lines: expect.arrayContaining([
        'Use this token to reset your password:',
      ]),
    }), expect.objectContaining({
      channel: 'email',
      route: 'ava@example.com',
      anonymous: true,
    }))
  })

  it('keeps auth delivery on the default hook when notifications are absent', async () => {
    const root = await createProject({
      auth: true,
    })

    const originalWarn = console.warn
    const warn = vi.fn()
    console.warn = warn

    vi.resetModules()

    try {
      const portable = await import('../src/portable')
      const originalImportOptionalModule = portable.holoRuntimeInternals.moduleInternals.importOptionalModule
      vi.spyOn(portable.holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier) => {
        if (specifier === '@holo-js/notifications') {
          return undefined
        }

        return await originalImportOptionalModule(specifier)
      })

      const runtime = await portable.createHolo(root, {
        processEnv: process.env,
        preferCache: false,
      })
      await runtime.initialize()
      await createSchemaService(DB.connection()).createTable('email_verification_tokens', (table) => {
        table.uuid('id').primaryKey()
        table.string('provider').default('users')
        table.string('user_id')
        table.string('email')
        table.string('token_hash')
        table.timestamp('expires_at')
        table.timestamp('used_at').nullable()
        table.timestamps()
        table.index(['provider'])
        table.index(['user_id'])
        table.index(['email'])
      })

      const registered = await runtime.auth?.register({
        name: 'Ava',
        email: 'ava@example.com',
        password: 'supersecret',
        passwordConfirmation: 'supersecret',
      })

      await expect(runtime.auth?.verification.create(registered!)).resolves.toMatchObject({
        email: 'ava@example.com',
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Email verification delivery is not configured'))
    } finally {
      console.warn = originalWarn
      vi.restoreAllMocks()
      vi.resetModules()
    }
  })

  it('keeps auth delivery on the default hook when notifications are installed without mail', async () => {
    const root = await createProject({
      auth: true,
      notifications: true,
    })

    const originalWarn = console.warn
    const warn = vi.fn()
    console.warn = warn

    try {
      const runtime = await createHolo(root, {
        processEnv: process.env,
        preferCache: false,
      })
      await runtime.initialize()
      await createSchemaService(DB.connection()).createTable('email_verification_tokens', (table) => {
        table.uuid('id').primaryKey()
        table.string('provider').default('users')
        table.string('user_id')
        table.string('email')
        table.string('token_hash')
        table.timestamp('expires_at')
        table.timestamp('used_at').nullable()
        table.timestamps()
        table.index(['provider'])
        table.index(['user_id'])
        table.index(['email'])
      })

      const registered = await runtime.auth?.register({
        name: 'Ava',
        email: 'ava@example.com',
        password: 'supersecret',
        passwordConfirmation: 'supersecret',
      })

      await expect(runtime.auth?.verification.create(registered!)).resolves.toMatchObject({
        email: 'ava@example.com',
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Email verification delivery is not configured'))
    } finally {
      console.warn = originalWarn
    }
  })

  it('falls back to mail delivery when mail is installed and notifications are absent', async () => {
    const root = await createProject({
      auth: true,
      mail: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const record = {
      ...(users.get(Number(id)) ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()
    await createSchemaService(DB.connection()).createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['user_id'])
      table.index(['email'])
    })
    await createSchemaService(DB.connection()).createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['email'])
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })

    const verificationToken = await runtime.auth?.verification.create(registered!) as VerificationTokenLike | undefined
    await runtime.auth?.passwords.request('ava@example.com')

    expect(listFakeSentMails()).toHaveLength(2)
    expect(listFakeSentMails()[0]!.mail).toMatchObject({
      subject: 'Verify your email address',
      to: [
        {
          email: 'ava@example.com',
          name: 'Ava',
        },
      ],
      text: expect.stringContaining(verificationToken?.plainTextToken ?? ''),
      metadata: expect.objectContaining({
        provider: 'users',
        tokenId: verificationToken?.id,
      }),
    })
    expect(listFakeSentMails()[1]!.mail).toMatchObject({
      subject: 'Reset your password',
      to: [
        {
          email: 'ava@example.com',
        },
      ],
      text: expect.stringContaining('Use this token to reset your password:'),
      metadata: expect.objectContaining({
        provider: 'users',
      }),
    })
  })

  it('does not leak hidden password fields from model-backed auth users', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
class UserEntity {
  constructor(attributes) {
    this.attributes = { ...attributes }
  }

  toAttributes() {
    return { ...this.attributes }
  }

  toJSON() {
    const { password, ...rest } = this.attributes
    return { ...rest }
  }
}

const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  query() {
    const filters = []
    return {
      where(column, value) {
        filters.push([column, value])
        return this
      },
      async first() {
        for (const record of users.values()) {
          const attributes = record.toAttributes()
          if (filters.every(([column, value]) => attributes?.[column] === value)) {
            return record
          }
        }

        return null
      },
    }
  },
  where(column, value) {
    return this.query().where(column, value)
  },
  async create(values) {
    const record = new UserEntity({
      id: nextId++,
      ...values,
    })
    users.set(record.toAttributes().id, record)
    return record
  },
  async update(id, values) {
    const current = users.get(Number(id))
    const record = new UserEntity({
      ...(current?.toAttributes() ?? { id: Number(id) }),
      ...values,
    })
    users.set(record.toAttributes().id, record)
    return record
  },
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).not.toHaveProperty('password')

    await runtime.auth?.login({
      email: 'ava@example.com',
      password: 'supersecret',
    })
    await expect(runtime.auth?.user()).resolves.not.toHaveProperty('password')
  })

  it('accepts trusted login for normal model instances on named guards', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
    admin: {
      driver: 'session',
      provider: 'admins',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
    admins: {
      model: 'Admin',
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), `
class UserEntity {
  constructor(attributes) {
    this.attributes = { ...attributes }
  }

  toAttributes() {
    return { ...this.attributes }
  }
}

const users = new Map()
let nextId = 1

export default class User extends UserEntity {
  static async find(id) {
    return users.get(Number(id)) ?? null
  }

  static where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record.toAttributes()?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  }

  static async create(values) {
    const record = new User({
      id: nextId++,
      ...values,
    })
    users.set(record.toAttributes().id, record)
    return record
  }

  static async update(id, values) {
    const current = users.get(Number(id))
    const record = new User({
      ...(current?.toAttributes() ?? { id: Number(id) }),
      ...values,
    })
    users.set(record.toAttributes().id, record)
    return record
  }
}
`, 'utf8')
    await writeFile(join(root, 'server/models/Admin.ts'), `
class AdminEntity {
  constructor(attributes) {
    this.attributes = { ...attributes }
  }

  toAttributes() {
    return { ...this.attributes }
  }
}

const admins = new Map()
let nextId = 1

export default class Admin extends AdminEntity {
  static async find(id) {
    return admins.get(Number(id)) ?? null
  }

  static where(column, value) {
    return {
      async first() {
        for (const record of admins.values()) {
          if (record.toAttributes()?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  }

  static async create(values) {
    const record = new Admin({
      id: nextId++,
      ...values,
    })
    admins.set(record.toAttributes().id, record)
    return record
  }

  static async update(id, values) {
    const current = admins.get(Number(id))
    const record = new Admin({
      ...(current?.toAttributes() ?? { id: Number(id) }),
      ...values,
    })
    admins.set(record.toAttributes().id, record)
    return record
  }
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const providers = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const users = providers.users as {
      create(input: Readonly<Record<string, unknown>>): Promise<unknown>
    }
    const admins = providers.admins as {
      create(input: Readonly<Record<string, unknown>>): Promise<unknown>
      matchesUser(user: unknown): boolean
    }
    const runtimeAdmins = authRuntimeInternals.getRuntimeBindings().providers.admins as {
      create(input: Readonly<Record<string, unknown>>): Promise<unknown>
      matchesUser(user: unknown): boolean
    }

    await users.create({
      email: 'user@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const crossRuntimeAdminUser = await admins.create({
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const runtimeAdminUser = await runtimeAdmins.create({
      email: 'runtime-admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    expect(admins.matchesUser(crossRuntimeAdminUser)).toBe(true)
    expect(runtimeAdmins.matchesUser(runtimeAdminUser)).toBe(true)

    await expect(runtime.auth?.guard('admin').loginUsing(runtimeAdminUser)).resolves.toMatchObject({
      guard: 'admin',
      user: {
        email: 'runtime-admin@example.com',
      },
    })
    await expect(runtime.auth?.guard('admin').user()).resolves.toMatchObject({
      email: 'runtime-admin@example.com',
    })
    await expect(runtime.auth?.guard('admin').loginUsing(crossRuntimeAdminUser)).resolves.toMatchObject({
      guard: 'admin',
      user: {
        email: 'runtime-admin@example.com',
      },
    })
    await expect(runtime.auth?.guard('admin').loginUsing({
      id: 1,
      email: 'admin@example.com',
      constructor: {
        name: 'Admin',
      },
    })).rejects.toThrow(
      'Pass a user id, a serialized auth user, or implement matchesUser()',
    )
    await expect(runtime.auth?.guard('web').loginUsing(runtimeAdminUser)).rejects.toThrow(
      'requires a user from provider "users"',
    )
  })

  it('isolates the default auth context between async request chains', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  query() {
    const filters = []
    return {
      where(column, value) {
        filters.push([column, value])
        return this
      },
      async first() {
        for (const record of users.values()) {
          if (filters.every(([column, value]) => record?.[column] === value)) {
            return record
          }
        }

        return null
      },
    }
  },
  where(column, value) {
    return this.query().where(column, value)
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const current = users.get(Number(id))
    const record = {
      ...(current ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    await new Promise<void>((resolvePromise, rejectPromise) => {
      setTimeout(() => {
        void (async () => {
          await runtime.auth?.register({
            name: 'Ava',
            email: 'ava@example.com',
            password: 'supersecret',
            passwordConfirmation: 'supersecret',
          })
          await runtime.auth?.login({
            email: 'ava@example.com',
            password: 'supersecret',
          })
          expect(await runtime.auth?.check()).toBe(true)
          expect(await runtime.auth?.user()).toMatchObject({
            email: 'ava@example.com',
          })
        })().then(resolvePromise, rejectPromise)
      }, 0)
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      setTimeout(() => {
        void (async () => {
          expect(await runtime.auth?.check()).toBe(false)
          expect(await runtime.auth?.user()).toBeNull()
        })().then(resolvePromise, rejectPromise)
      }, 0)
    })

    await runtime.shutdown()
  })

  it('does not leak auth state when the facade is cached before later async work', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  query() {
    const filters = []
    return {
      where(column, value) {
        filters.push([column, value])
        return this
      },
      async first() {
        for (const record of users.values()) {
          if (filters.every(([column, value]) => record?.[column] === value)) {
            return record
          }
        }

        return null
      },
    }
  },
  where(column, value) {
    return this.query().where(column, value)
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const current = users.get(Number(id))
    const record = {
      ...(current ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const auth = runtime.auth

    await new Promise<void>((resolvePromise, rejectPromise) => {
      setTimeout(() => {
        void (async () => {
          await auth?.register({
            name: 'Ava',
            email: 'ava@example.com',
            password: 'supersecret',
            passwordConfirmation: 'supersecret',
          })
          await auth?.login({
            email: 'ava@example.com',
            password: 'supersecret',
          })
          expect(await auth?.check()).toBe(true)
          expect(await auth?.user()).toMatchObject({
            email: 'ava@example.com',
          })
        })().then(resolvePromise, rejectPromise)
      }, 0)
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      setTimeout(() => {
        void (async () => {
          expect(await auth?.check()).toBe(false)
          expect(await auth?.user()).toBeNull()
        })().then(resolvePromise, rejectPromise)
      }, 0)
    })

    await runtime.shutdown()
  })

  it('boots auth with the default file session store when session config is omitted', async () => {
    const root = await createProject({
      auth: true,
      session: false,
    })
    const runtime = await createHolo(root, {
      envName: 'development',
    })

    await runtime.initialize()

    expect(runtime.session).toBeDefined()
    expect(runtime.auth).toBeDefined()

    const createdSession = await runtime.session?.create({
      data: {
        auth: {
          provider: 'users',
        },
      },
    }) as SessionRecordLike | undefined

    expect(createdSession?.store).toBe('file')
  })

  it('uses the project default database connection when a database session store leaves it implicit', async () => {
    const root = await createProject({
      session: 'database',
    })
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${configEntry}

export default defineSessionConfig({
  driver: 'database',
  stores: {
    database: {
      driver: 'database',
      table: 'sessions',
    },
  },
})
`, 'utf8')
    const runtime = await createHolo(root, {
      envName: 'development',
    })

    await runtime.initialize()
    await createSchemaService(DB.connection()).createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store')
      table.json('data')
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.string('remember_token_hash').nullable()
    })

    const createdSession = await runtime.session?.create({
      data: {
        source: 'default-database-connection',
      },
    }) as SessionRecordLike | undefined

    expect(createdSession?.store).toBe('database')
    await expect(runtime.session?.read(String(createdSession?.id))).resolves.toMatchObject({
      id: createdSession?.id,
    })
  })

  it('fails clearly when session config requires @holo-js/session to be installed', async () => {
    const root = await createProject({
      session: 'file',
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/session') {
          return undefined
        }

        return original(specifier)
      })

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(runtime.initialize()).rejects.toThrow('Session support requires @holo-js/session to be installed')
  })

  it('fails clearly when auth config requires @holo-js/auth to be installed', async () => {
    const root = await createProject({
      auth: true,
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/auth') {
          return undefined
        }

        return original(specifier)
      })

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(runtime.initialize()).rejects.toThrow('Auth support requires @holo-js/auth to be installed')
  })

  it('boots file-backed sessions from absolute paths and fails for unsupported configured drivers', async () => {
    const root = await createProject({
      session: 'file',
    })
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${configEntry}

export default defineSessionConfig({
  driver: 'file',
  stores: {
    file: {
      driver: 'file',
      path: ${JSON.stringify(join(root, 'storage/framework/sessions'))},
    },
  },
})
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    await runtime.initialize()
    expect(runtime.session).toBeDefined()

    await runtime.shutdown()

    const invalidRoot = await createProject({
      session: 'file',
    })
    await writeFile(join(invalidRoot, 'config/session.ts'), `
import { defineSessionConfig } from ${configEntry}

export default defineSessionConfig({
  driver: 'redis',
  stores: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      prefix: 'sessions:',
    },
  },
})
`, 'utf8')

    await expect(createHolo(invalidRoot, {
      processEnv: process.env,
      preferCache: false,
    })).rejects.toThrow('Redis-backed session stores are not supported by the portable runtime yet')
  })

  it('loads pending-schema auth model modules without treating them as missing', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
export const holoModelPendingSchema = true
export default undefined
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()
    expect(runtime.auth).toBeDefined()
    await expect(runtime.auth?.check()).resolves.toBe(false)
    await expect(runtime.auth?.register({
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    } as never)).rejects.toThrow('pending generated schema output')
  })

  it('fails clearly when auth config references a provider package that is not installed', async () => {
    const root = await createProject({
      auth: true,
      social: true,
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/auth-social') {
          return undefined
        }

        return original(specifier)
      })

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(runtime.initialize()).rejects.toThrow('Social auth config requires @holo-js/auth-social to be installed')
  })

  it('loads configured social providers lazily and persists social state plus identity links', async () => {
    const root = await createProject({
      auth: true,
      social: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const socialBindings = await holoRuntimeInternals.createCoreSocialBindings(runtime.loadedConfig, await import('@holo-js/session'))

    await socialBindings.stateStore.create({
      provider: 'google',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      guard: 'web',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    const pending = await socialBindings.stateStore.read('google', 'state-1')
    expect(pending).toMatchObject({
      provider: 'google',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      guard: 'web',
    })
    expect(pending?.createdAt).toBeInstanceOf(Date)

    await socialBindings.stateStore.delete('google', 'state-1')
    await expect(socialBindings.stateStore.read('google', 'state-1')).resolves.toBeNull()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('auth_identities', table => {
      table.id()
      table.bigInteger('user_id')
      table.string('guard').nullable().default('web')
      table.string('auth_provider').nullable().default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.json('tokens').default({})
      table.timestamps()
    })

    await socialBindings.identityStore.save({
      provider: 'google',
      providerUserId: 'google-user',
      guard: 'web',
      authProvider: 'users',
      userId: 1,
      email: 'user@example.com',
      emailVerified: true,
      profile: { id: 'google-user' },
      tokens: { accessToken: 'token' },
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    await expect(socialBindings.identityStore.findByProviderUserId('google', 'google-user')).resolves.toMatchObject({
      provider: 'google',
      providerUserId: 'google-user',
      guard: 'web',
      authProvider: 'users',
      userId: 1,
      email: 'user@example.com',
      emailVerified: true,
    })
    await expect(socialBindings.identityStore.findByProviderUserId('google', 'missing')).resolves.toBeNull()
  })

  it('fails clearly when a configured social provider package is missing or malformed', async () => {
    const root = await createProject({
      auth: true,
      social: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule

    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/auth-social-google') {
          return undefined
        }

        return original(specifier)
      })

    await expect(holoRuntimeInternals.loadConfiguredSocialProviders(runtime.loadedConfig)).rejects.toThrow(
      'Social provider "google" requires @holo-js/auth-social-google to be installed',
    )

    vi.restoreAllMocks()
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/auth-social-google') {
          return {}
        }

        return original(specifier)
      })

    await expect(holoRuntimeInternals.loadConfiguredSocialProviders(runtime.loadedConfig)).rejects.toThrow(
      'did not export a runtime',
    )

    await expect(holoRuntimeInternals.loadConfiguredSocialProviders({
      ...runtime.loadedConfig,
      auth: {
        ...runtime.loadedConfig.auth,
        social: {
          custom: {
            name: 'custom',
            runtime: '@acme/holo-auth-social-custom',
            clientId: 'client',
            clientSecret: 'secret',
            redirectUri: 'https://app.test/auth/custom/callback',
            scopes: [],
            encryptTokens: false,
          },
        },
      },
    })).rejects.toThrow('requires @acme/holo-auth-social-custom to be installed')

    expect(holoRuntimeInternals.normalizeDateValue(new Date('2026-01-01T00:00:00.000Z'))).toBeInstanceOf(Date)
    expect(holoRuntimeInternals.normalizeDateValue('2026-01-01T00:00:00.000Z')).toBeInstanceOf(Date)
    expect(holoRuntimeInternals.normalizeJsonValue({ ok: true })).toEqual({ ok: true })
    expect(holoRuntimeInternals.normalizeJsonValue('{')).toBe('{')
  })

  it('returns no social providers when loaded with only a project root', async () => {
    const root = await createProject({
      auth: true,
    })

    await expect(holoRuntimeInternals.loadConfiguredSocialProviders(root)).resolves.toEqual({})
  })

  it('loads custom social providers from an explicit runtime package', async () => {
    const root = await createProject({
      auth: true,
      social: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule
    const customRuntime = { custom: true }

    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@acme/holo-auth-social-custom') {
          return {
            default: customRuntime,
          }
        }

        return original(specifier)
      })

    await expect(holoRuntimeInternals.loadConfiguredSocialProviders({
      ...runtime.loadedConfig,
      auth: {
        ...runtime.loadedConfig.auth,
        social: {
          custom: {
            name: 'custom',
            runtime: '@acme/holo-auth-social-custom',
            clientId: 'client',
            clientSecret: 'secret',
            redirectUri: 'https://app.test/auth/custom/callback',
            scopes: [],
            encryptTokens: false,
          },
        },
      },
    })).resolves.toEqual({
      custom: customRuntime,
    })
  })

  it('covers social binding fallbacks for invalid session data and missing auth identity fields', async () => {
    const root = await createProject({
      auth: true,
      social: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const socialBindings = await holoRuntimeInternals.createCoreSocialBindings(runtime.loadedConfig, await import('@holo-js/session'))
    const sessionRuntime = runtime.session!

    await sessionRuntime.create({
      id: 'oauth:google:bad-1',
      data: {},
    })
    await sessionRuntime.create({
      id: 'oauth:google:bad-2',
      data: {
        codeVerifier: 123,
        guard: 'web',
      } as never,
    })

    await expect(socialBindings.stateStore.read('google', 'bad-1')).resolves.toBeNull()
    await expect(socialBindings.stateStore.read('google', 'bad-2')).resolves.toBeNull()

    await sessionRuntime.create({
      id: 'oauth:google:missing-created-at',
      data: {
        codeVerifier: 'verifier-3',
        guard: 'web',
      } as never,
    })
    await expect(socialBindings.stateStore.read('google', 'missing-created-at')).resolves.toMatchObject({
      codeVerifier: 'verifier-3',
      guard: 'web',
    })

    const schema = createSchemaService(DB.connection())
    await schema.createTable('auth_identities', table => {
      table.id()
      table.bigInteger('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.json('tokens').default({})
      table.timestamps()
    })

    await DB.table('auth_identities').insert({
      user_id: 2,
      provider: 'google',
      provider_user_id: 'fallback-user',
      email: null,
      email_verified: '1',
      profile: 'not-json',
      tokens: '{"accessToken":"abc"}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    await expect(socialBindings.identityStore.findByProviderUserId('google', 'fallback-user')).resolves.toMatchObject({
      guard: 'web',
      authProvider: 'users',
      emailVerified: true,
      profile: {},
      tokens: {
        accessToken: 'abc',
      },
    })

    await socialBindings.identityStore.save({
      provider: 'google',
      providerUserId: 'fallback-user',
      guard: 'web',
      authProvider: 'users',
      userId: 2,
      email: 'updated@example.com',
      emailVerified: false,
      profile: { id: 'fallback-user', updated: true },
      tokens: { accessToken: 'updated' },
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    })

    await expect(socialBindings.identityStore.findByProviderUserId('google', 'fallback-user')).resolves.toMatchObject({
      email: 'updated@example.com',
      emailVerified: false,
      tokens: {
        accessToken: 'updated',
      },
    })

    const adminBindings = await holoRuntimeInternals.createCoreSocialBindings({
      ...runtime.loadedConfig,
      auth: {
        ...runtime.loadedConfig.auth,
        guards: {
          ...runtime.loadedConfig.auth.guards,
          admin: {
            name: 'admin',
            driver: 'session',
            provider: 'admins',
          },
        },
      },
    }, await import('@holo-js/session'))
    const originalTable = DB.table.bind(DB)
    const tableSpy = vi.spyOn(DB, 'table')
      .mockImplementation(((tableName: string) => {
        if (tableName !== 'auth_identities') {
          return originalTable(tableName as never)
        }

        return {
          where() {
            return this
          },
          async first() {
            return {
              user_id: 3,
              guard: 'admin',
              auth_provider: undefined,
              provider: 'google',
              provider_user_id: 'admin-fallback',
              email: null,
              email_verified: 0,
              profile: '{}',
              tokens: '{}',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            }
          },
        }
      }) as typeof DB.table)

    await expect(adminBindings.identityStore.findByProviderUserId('google', 'admin-fallback')).resolves.toMatchObject({
      guard: 'admin',
      authProvider: 'admins',
    })

    const malformedBindings = await holoRuntimeInternals.createCoreSocialBindings({
      ...runtime.loadedConfig,
      auth: {
        ...runtime.loadedConfig.auth,
        guards: {} as never,
      },
    }, await import('@holo-js/session'))
    tableSpy.mockImplementation(((tableName: string) => {
      if (tableName !== 'auth_identities') {
        return originalTable(tableName as never)
      }

      return {
        where() {
          return this
        },
        async first() {
          return {
            user_id: 4,
            guard: undefined,
            auth_provider: undefined,
            provider: 'google',
            provider_user_id: 'users-fallback',
            email: null,
            email_verified: 0,
            profile: '{}',
            tokens: '{}',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          }
        },
      }
    }) as typeof DB.table)

    await expect(malformedBindings.identityStore.findByProviderUserId('google', 'users-fallback')).resolves.toMatchObject({
      authProvider: 'users',
    })

    tableSpy.mockImplementation(((tableName: string) => {
      if (tableName !== 'auth_identities') {
        return originalTable(tableName as never)
      }

      return {
        where() {
          return this
        },
        async first() {
          return {
            user_id: 5,
            provider: undefined,
            provider_user_id: undefined,
            guard: 'missing-guard',
            auth_provider: undefined,
            email: 42,
            email_verified: false,
            profile: 'null',
            tokens: undefined,
            created_at: undefined,
            updated_at: undefined,
          }
        },
      }
    }) as typeof DB.table)

    await expect(socialBindings.identityStore.findByProviderUserId('google', 'provider-fallback')).resolves.toMatchObject({
      provider: 'google',
      providerUserId: 'provider-fallback',
      authProvider: 'users',
      email: undefined,
      tokens: undefined,
    })

    let savedPayload: Record<string, unknown> | undefined
    tableSpy.mockImplementation(((tableName: string) => {
      if (tableName !== 'auth_identities') {
        return originalTable(tableName as never)
      }

      return {
        where() {
          return this
        },
        async first() {
          return undefined
        },
        async insert(payload: Record<string, unknown>) {
          savedPayload = payload
        },
      }
    }) as typeof DB.table)

    await socialBindings.identityStore.save({
      provider: 'google',
      providerUserId: 'missing-optionals',
      guard: 'web',
      authProvider: 'users',
      userId: 6,
      emailVerified: true,
      profile: { id: 'missing-optionals' },
      linkedAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    })

    expect(savedPayload).toMatchObject({
      email: null,
      tokens: '{}',
    })
    tableSpy.mockRestore()
  })

  it('passes the social token encryption key into the configured social runtime', async () => {
    const root = await createProject({
      auth: true,
      social: true,
      socialEncryptionKey: 'phase-6-encryption-key',
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const socialModule = await import('@holo-js/auth-social')
    expect(socialModule.socialAuthInternals.getBindings().encryptionKey).toBe('phase-6-encryption-key')
  })

  it('covers auth provider adapter credential branches for empty credentials, query builders, and partial where chains', async () => {
    const root = await createProject({
      auth: true,
    })

    await writeFile(join(root, 'server/models/User.ts'), `
const records = [
  { id: 1, email: 'query@example.com', role: 'admin' },
  { id: 2, email: 'single@example.com', role: 'member' },
]

export default {
  async find(id) {
    return records.find(record => record.id === Number(id)) ?? null
  },
  query() {
    const filters = []
    return {
      where(column, value) {
        filters.push([column, value])
        return this
      },
      async first() {
        return records.find(record => filters.every(([column, value]) => record[column] === value)) ?? null
      },
    }
  },
  where(column, value) {
    const firstMatch = records.find(record => record[column] === value) ?? null
    return {
      async first() {
        return firstMatch
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const providers = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const users = providers.users as {
      findByCredentials(credentials: Record<string, unknown>): Promise<unknown | null>
    }

    await expect(users.findByCredentials({})).resolves.toBeNull()
    await expect(users.findByCredentials({ email: 'query@example.com', role: 'admin' })).resolves.toMatchObject({
      email: 'query@example.com',
      role: 'admin',
    })
    await expect(users.findByCredentials({ email: 'missing@example.com', role: 'ghost' })).resolves.toBeNull()

    const fallbackRoot = await createProject({
      auth: true,
    })

    await writeFile(join(fallbackRoot, 'server/models/User.ts'), `
const records = [
  { id: 3, email: 'single@example.com', role: 'member' },
]

export default {
  async find(id) {
    return records.find(record => record.id === Number(id)) ?? null
  },
  where(column, value) {
    let matched = records.find(record => record[column] === value) ?? null
    return {
      where: undefined,
      async first() {
        return matched
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')

    const fallbackRuntime = await createHolo(fallbackRoot, {
      processEnv: process.env,
      preferCache: false,
    })
    const fallbackProviders = await holoRuntimeInternals.createCoreAuthProviders(fallbackRoot, fallbackRuntime.loadedConfig)
    const fallbackUsers = fallbackProviders.users as {
      findByCredentials(credentials: Record<string, unknown>): Promise<unknown | null>
    }

    await expect(fallbackUsers.findByCredentials({ email: 'single@example.com', role: 'member' })).resolves.toMatchObject({
      email: 'single@example.com',
      role: 'member',
    })

    const chainedRoot = await createProject({
      auth: true,
    })

    await writeFile(join(chainedRoot, 'server/models/User.ts'), `
const records = [
  { id: 4, email: 'chain@example.com', role: 'editor' },
]

export default {
  async find(id) {
    return records.find(record => record.id === Number(id)) ?? null
  },
  where(column, value) {
    const filters = [[column, value]]
    return {
      where(nextColumn, nextValue) {
        filters.push([nextColumn, nextValue])
        return this
      },
      async first() {
        return records.find(record => filters.every(([key, current]) => record[key] === current)) ?? null
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')

    const chainedRuntime = await createHolo(chainedRoot, {
      processEnv: process.env,
      preferCache: false,
    })
    const chainedProviders = await holoRuntimeInternals.createCoreAuthProviders(chainedRoot, chainedRuntime.loadedConfig)
    const chainedUsers = chainedProviders.users as {
      findByCredentials(credentials: Record<string, unknown>): Promise<unknown | null>
    }

    await expect(chainedUsers.findByCredentials({ email: 'chain@example.com', role: 'editor' })).resolves.toMatchObject({
      email: 'chain@example.com',
      role: 'editor',
    })
  })

  it('rethrows dependency import failures from an existing auth model file', async () => {
    const root = await createProject({
      auth: true,
    })

    await writeFile(join(root, 'server/models/User.ts'), `
import './missing-dependency'

export default {
  async find() {
    return null
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)).rejects.toThrow('missing-dependency')
  })

  it('filters hosted-auth profile writes and honors model auth input hooks', async () => {
    const root = await createProject({
      auth: true,
    })

    await writeFile(join(root, 'server/models/User.ts'), `
const records = new Map()

export async function prepareAuthCreateInput(input) {
  return {
    ...input,
    public_id: 'generated-public-id',
    team_id: 7,
  }
}

export async function prepareAuthUpdateInput(_user, input) {
  return {
    ...input,
    ignored_column: 'ignored',
  }
}

export default {
  definition: {
    table: {
      columns: {
        id: {},
        public_id: {},
        team_id: {},
        email: {},
        name: {},
        password: {},
        email_verified_at: {},
      },
    },
    fillable: ['email', 'name', 'password', 'email_verified_at'],
    guarded: ['id'],
    hasExplicitFillable: true,
  },
  async find(id) {
    return records.get(Number(id)) ?? null
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    records.set(1, { id: 1, ...values })
    return { id: 1, ...values }
  },
  async update(id, values) {
    records.set(Number(id), { id: Number(id), ...values })
    return { id: Number(id), ...values }
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const providers = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const users = providers.users as {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>
      update(user: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>>
    }

    await expect(users.create({
      email: 'hosted@example.com',
      name: 'Hosted User',
      avatar: 'https://cdn.test/avatar.png',
      email_verified_at: new Date('2026-04-11T00:00:00.000Z'),
    })).resolves.toEqual({
      id: 1,
      public_id: 'generated-public-id',
      team_id: 7,
      email: 'hosted@example.com',
      name: 'Hosted User',
      email_verified_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    await expect(users.update({ id: 1 }, {
      name: 'Updated Hosted User',
      avatar: 'https://cdn.test/avatar-2.png',
      email_verified_at: new Date('2026-04-12T00:00:00.000Z'),
    })).resolves.toEqual({
      id: 1,
      name: 'Updated Hosted User',
      email_verified_at: new Date('2026-04-12T00:00:00.000Z'),
    })
  })

  it('allows wildcard fillable auth writes and falls back when no update hook is exported', async () => {
    const root = await createProject({
      auth: true,
    })

    await writeFile(join(root, 'server/models/User.ts'), `
const records = new Map()

export default {
  definition: {
    table: {
      columns: {
        id: {},
        email: {},
        name: {},
        password: {},
        role: {},
      },
    },
    fillable: ['*'],
    guarded: ['id'],
  },
  async find(id) {
    return records.get(Number(id)) ?? null
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    records.set(1, { id: 1, ...values })
    return { id: 1, ...values }
  },
  async update(id, values) {
    const next = { ...(records.get(Number(id)) ?? { id: Number(id) }), ...values }
    records.set(Number(id), next)
    return next
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const providers = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const users = providers.users as {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>
      update(user: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>>
    }

    await expect(users.create({
      email: 'wildcard@example.com',
      name: 'Wildcard User',
      role: 'admin',
      ignored_column: 'nope',
    })).resolves.toEqual({
      id: 1,
      email: 'wildcard@example.com',
      name: 'Wildcard User',
      role: 'admin',
    })

    await expect(users.update({ id: 1 }, {
      name: 'Wildcard Updated',
      role: 'owner',
      ignored_column: 'still-nope',
    })).resolves.toEqual({
      id: 1,
      email: 'wildcard@example.com',
      name: 'Wildcard Updated',
      role: 'owner',
    })
  })

  it('drops all hosted-auth profile writes when the model guards every column', async () => {
    const root = await createProject({
      auth: true,
    })

    await writeFile(join(root, 'server/models/User.ts'), `
const records = new Map()

export default {
  definition: {
    table: {
      columns: {
        id: {},
        email: {},
        name: {},
      },
    },
    fillable: ['*'],
    guarded: ['*'],
  },
  async find(id) {
    return records.get(Number(id)) ?? null
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    records.set(1, { id: 1, ...values })
    return { id: 1, ...values }
  },
  async update(id, values) {
    const next = { ...(records.get(Number(id)) ?? { id: Number(id) }), ...values }
    records.set(Number(id), next)
    return next
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })
    const providers = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const users = providers.users as {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>
      update(user: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>>
    }

    await expect(users.create({
      email: 'guarded@example.com',
      name: 'Guarded User',
    })).resolves.toEqual({
      id: 1,
    })

    await expect(users.update({ id: 1 }, {
      email: 'still-guarded@example.com',
      name: 'Still Guarded',
    })).resolves.toEqual({
      id: 1,
    })
  })

  it('fails clearly when WorkOS and Clerk auth config references packages that are not installed', async () => {
    const workosRoot = await createProject({
      auth: true,
      workos: true,
    })
    const clerkRoot = await createProject({
      auth: true,
      clerk: true,
    })
    const original = holoRuntimeInternals.moduleInternals.importOptionalModule
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule')
      .mockImplementation(async (specifier: string) => {
        if (specifier === '@holo-js/auth-workos' || specifier === '@holo-js/auth-clerk') {
          return undefined
        }

        return original(specifier)
      })

    const workosRuntime = await createHolo(workosRoot, {
      processEnv: process.env,
      preferCache: false,
    })
    const clerkRuntime = await createHolo(clerkRoot, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(workosRuntime.initialize()).rejects.toThrow('WorkOS auth config requires @holo-js/auth-workos to be installed')
    await expect(clerkRuntime.initialize()).rejects.toThrow('Clerk auth config requires @holo-js/auth-clerk to be installed')
  })

  it('boots when hosted auth packages are installed and lets apps configure verifier runtimes separately', async () => {
    const workosRoot = await createProject({
      auth: true,
      workos: true,
    })
    const clerkRoot = await createProject({
      auth: true,
      clerk: true,
    })

    const workosRuntime = await createHolo(workosRoot, {
      processEnv: process.env,
      preferCache: false,
    })
    const clerkRuntime = await createHolo(clerkRoot, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(workosRuntime.initialize()).resolves.toBeUndefined()
    expect(workosRuntime.initialized).toBe(true)
    await workosRuntime.shutdown()

    await expect(clerkRuntime.initialize()).resolves.toBeUndefined()
    expect(clerkRuntime.initialized).toBe(true)
    await clerkRuntime.shutdown()
  })

  it('namespaces WorkOS and Clerk hosted identities independently', async () => {
    const root = await createProject({
      auth: true,
      workos: true,
      clerk: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('auth_identities', table => {
      table.id()
      table.bigInteger('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.timestamps()
    })

    const workosStore = holoRuntimeInternals.createCoreHostedIdentityStore('workos')
    const clerkStore = holoRuntimeInternals.createCoreHostedIdentityStore('clerk')

    await workosStore.save({
      provider: 'default',
      providerUserId: 'workos-user',
      guard: 'web',
      authProvider: 'users',
      userId: 1,
      email: 'workos@app.test',
      emailVerified: true,
      profile: { id: 'workos-user' },
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await clerkStore.save({
      provider: 'default',
      providerUserId: 'clerk-user',
      guard: 'web',
      authProvider: 'users',
      userId: 1,
      email: 'clerk@app.test',
      emailVerified: true,
      profile: { id: 'clerk-user' },
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    await expect(workosStore.findByUserId('default', 'users', 1)).resolves.toMatchObject({
      provider: 'default',
      providerUserId: 'workos-user',
      email: 'workos@app.test',
    })
    await expect(clerkStore.findByUserId('default', 'users', 1)).resolves.toMatchObject({
      provider: 'default',
      providerUserId: 'clerk-user',
      email: 'clerk@app.test',
    })
  })

  it('does not match social identity rows when resolving hosted identity fallbacks', async () => {
    const root = await createProject({
      auth: true,
      workos: true,
    })
    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('auth_identities', table => {
      table.id()
      table.bigInteger('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.timestamps()
    })

    await DB.table('auth_identities').insert({
      user_id: 11,
      guard: 'web',
      auth_provider: 'users',
      provider: 'google',
      provider_user_id: 'provider-user-1',
      email: 'social@app.test',
      email_verified: 1,
      profile: JSON.stringify({ id: 'provider-user-1', kind: 'social' }),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    const workosStore = holoRuntimeInternals.createCoreHostedIdentityStore('workos')
    await expect(workosStore.findByProviderUserId('google', 'provider-user-1')).resolves.toBeNull()

    await workosStore.save({
      provider: 'google',
      providerUserId: 'provider-user-1',
      guard: 'web',
      authProvider: 'users',
      userId: 22,
      email: 'hosted@app.test',
      emailVerified: true,
      profile: { id: 'provider-user-1', kind: 'hosted' },
      linkedAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    })

    const rows = await DB.table('auth_identities')
      .where('provider_user_id', 'provider-user-1')
      .get<Record<string, unknown>>()
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.provider)).toEqual(expect.arrayContaining(['google', 'workos:google']))
  })

  it('boots database-backed sessions and auth providers resolved from alternate model files', async () => {
    const root = await createProject({
      auth: true,
      session: 'database',
    })
    await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.mts'), `
export default {
  users: new Map(),
  nextId: 1,
  async find(id) {
    return this.users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      first: async () => {
        for (const record of this.users.values()) {
          if (record[column] === value) {
            return {
              toJSON() {
                return { ...record }
              },
            }
          }
        }
        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: this.nextId++,
      ...values,
    }
    this.users.set(record.id, record)
    return {
      toJSON() {
        return { ...record }
      },
    }
  },
  async update(id, values) {
    const current = this.users.get(Number(id))
    const record = {
      ...(current ?? { id: Number(id) }),
      ...values,
    }
    this.users.set(record.id, record)
    return {
      toJSON() {
        return { ...record }
      },
    }
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()
    await createSchemaService(DB.connection()).createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store')
      table.json('data')
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.string('remember_token_hash').nullable()
    })

    const createdSession = await runtime.session?.create({
      data: {
        guard: 'web',
      },
    }) as SessionRecordLike | undefined
    expect(createdSession?.store).toBe('database')
    expect(await runtime.session?.read(String(createdSession?.id))).toMatchObject({
      id: createdSession?.id,
      data: {
        guard: 'web',
      },
    })
    await runtime.session?.issueRememberMeToken(String(createdSession?.id))
    expect(await runtime.session?.read(String(createdSession?.id))).toMatchObject({
      id: createdSession?.id,
      rememberTokenHash: expect.any(String),
    })
    await runtime.session?.touch(String(createdSession?.id))
    await runtime.session?.invalidate(String(createdSession?.id))
    await expect(runtime.session?.read(String(createdSession?.id))).resolves.toBeNull()
    await expect(runtime.session?.read('missing-session')).resolves.toBeNull()

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).toMatchObject({
      email: 'ava@example.com',
    })
  })

  it('uses configured password reset broker tables instead of the default table', async () => {
    const root = await createProject({
      session: 'database',
      auth: true,
    })
    await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'admins',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  passwords: {
    admins: {
      provider: 'users',
      table: 'admin_password_reset_tokens',
      expire: 60,
      throttle: 60,
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id))
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return undefined
      },
    }
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const record = {
      ...(users.get(Number(id)) ?? { id: Number(id) }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      envName: 'development',
    })
    await runtime.initialize()

    await createSchemaService(DB.connection()).createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store')
      table.json('data')
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.string('remember_token_hash').nullable()
    })
    await createSchemaService(DB.connection()).createTable('admin_password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamp('updated_at')
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).toMatchObject({
      email: 'ava@example.com',
    })

    await runtime.auth?.passwords.request('ava@example.com')
    const rows = await DB.table('admin_password_reset_tokens').get<Record<string, unknown>>()
    expect(rows).toHaveLength(1)
  })

  it('uses the shared security limiter for password reset throttling when security is configured', async () => {
    const root = await createProject({
      session: 'database',
      auth: true,
      notifications: true,
      mail: true,
    })
    await writeFile(join(root, 'config/security.ts'), `
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'memory',
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: nextId++,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const record = users.get(Number(id))
    if (!record) {
      return null
    }

    Object.assign(record, values)
    return record
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()
    await createSchemaService(DB.connection()).createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamp('updated_at')
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })

    expect(registered).toMatchObject({
      email: 'ava@example.com',
    })

    await runtime.auth?.passwords.request('ava@example.com')
    expect(listFakeSentMails()).toHaveLength(1)

    const firstTokenRows = await DB.table('password_reset_tokens').get<Record<string, unknown>>()
    expect(firstTokenRows).toHaveLength(1)

    const firstTokenId = firstTokenRows[0]?.id
    expect(typeof firstTokenId).toBe('string')

    await DB.table('password_reset_tokens').where('id', firstTokenId as string).update({
      created_at: '2000-01-01T00:00:00.000Z',
    })

    await runtime.auth?.passwords.request('ava@example.com')

    expect(listFakeSentMails()).toHaveLength(1)
    const finalTokenRows = await DB.table('password_reset_tokens').get<Record<string, unknown>>()
    expect(finalTokenRows).toHaveLength(1)
    expect(finalTokenRows[0]?.id).toBe(firstTokenId)
  })

  it('persists auth user references through string user_id columns', async () => {
    const root = await createProject({
      auth: true,
      session: false,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
const users = new Map()
let nextId = 1

export default {
  async find(id) {
    return users.get(String(id)) ?? null
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: \`user-\${nextId++}\`,
      ...values,
    }
    users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const key = String(id)
    const record = {
      ...(users.get(key) ?? { id: key }),
      ...values,
    }
    users.set(record.id, record)
    return record
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      envName: 'development',
    })
    await runtime.initialize()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('personal_access_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('name')
      table.string('token_hash').unique()
      table.json('abilities').default([])
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps()
    })
    await schema.createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
    })
    await schema.createTable('auth_identities', (table) => {
      table.id()
      table.string('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.timestamps()
    })

    const registered = await runtime.auth?.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).toMatchObject({
      id: 'user-1',
    })

    const createdToken = await runtime.auth?.tokens.create(registered!, {
      name: 'browser',
    })
    expect(createdToken).toMatchObject({
      userId: 'user-1',
    })
    await expect(runtime.auth?.tokens.list(registered!)).resolves.toMatchObject([
      {
        userId: 'user-1',
      },
    ])

    const verificationToken = await runtime.auth?.verification.create(registered!) as VerificationTokenLike | undefined
    expect(verificationToken).toMatchObject({
      userId: 'user-1',
    })

    const hostedIdentityStore = holoRuntimeInternals.createCoreHostedIdentityStore('clerk')
    await hostedIdentityStore.save({
      provider: 'app',
      providerUserId: 'clerk_user_1',
      guard: 'web',
      authProvider: 'users',
      userId: 'user-1',
      email: 'ava@example.com',
      emailVerified: true,
      profile: { id: 'clerk_user_1' },
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    await expect(hostedIdentityStore.findByUserId('app', 'users', 'user-1')).resolves.toMatchObject({
      userId: 'user-1',
    })

    const tokenRows = await DB.table('personal_access_tokens').get<Record<string, unknown>>()
    expect(tokenRows[0]?.user_id).toBe('user-1')
    const verificationRows = await DB.table('email_verification_tokens').get<Record<string, unknown>>()
    expect(verificationRows[0]?.user_id).toBe('user-1')
    const identityRows = await DB.table('auth_identities').get<Record<string, unknown>>()
    expect(identityRows[0]?.user_id).toBe('user-1')
  })

  it('covers core auth store helpers, provider markers, and pending auth providers directly', async () => {
    const root = await createProject({
      auth: true,
      session: 'database',
    })
    const runtime = await createHolo(root, {
      envName: 'development',
    })
    await runtime.initialize()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store')
      table.json('data')
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.string('remember_token_hash').nullable()
    })
    await schema.createTable('personal_access_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('name')
      table.string('token_hash').unique()
      table.json('abilities').default([])
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps()
    })
    await schema.createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
    })
    await schema.createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamp('updated_at')
    })
    await schema.createTable('admin_password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamp('updated_at')
    })
    await schema.createTable('auth_identities', (table) => {
      table.id()
      table.string('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.timestamps()
    })

    const stores = holoRuntimeInternals.createCoreAuthStores(runtime.loadedConfig)
    await stores.tokens.create({
      id: 'token-1',
      provider: 'users',
      userId: 'user-1',
      name: 'browser',
      abilities: ['orders.read'],
      tokenHash: 'sha256$hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
      expiresAt: null,
    })
    await expect(stores.tokens.findById('token-1')).resolves.toMatchObject({
      id: 'token-1',
      userId: 'user-1',
      lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(stores.tokens.listByUserId('users', 'user-1')).resolves.toHaveLength(1)
    await stores.tokens.update({
      id: 'token-1',
      provider: 'users',
      userId: 'user-1',
      name: 'mobile',
      abilities: ['*'],
      tokenHash: 'sha256$hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-03T00:00:00.000Z'),
    })
    await expect(stores.tokens.findById('token-1')).resolves.toMatchObject({
      name: 'mobile',
      expiresAt: new Date('2026-01-03T00:00:00.000Z'),
    })
    await expect(stores.tokens.deleteByUserId('users', 'user-1')).resolves.toBe(1)
    await stores.tokens.create({
      id: 'token-2',
      provider: 'users',
      userId: 'user-2',
      name: 'browser',
      abilities: [],
      tokenHash: 'sha256$hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: null,
    })
    await stores.tokens.delete('token-2')
    await expect(stores.tokens.findById('token-2')).resolves.toBeNull()

    await stores.emailVerificationTokens.create({
      id: 'verify-1',
      provider: 'users',
      userId: 'user-1',
      email: 'ava@example.com',
      tokenHash: 'sha256$verify',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(stores.emailVerificationTokens.findById('verify-1')).resolves.toMatchObject({
      userId: 'user-1',
      email: 'ava@example.com',
    })
    await expect(stores.emailVerificationTokens.deleteByUserId('users', 'user-1')).resolves.toBe(1)
    await stores.emailVerificationTokens.create({
      id: 'verify-2',
      provider: 'users',
      userId: 'user-2',
      email: 'mina@example.com',
      tokenHash: 'sha256$verify',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await stores.emailVerificationTokens.delete('verify-2')
    await expect(stores.emailVerificationTokens.findById('verify-2')).resolves.toBeNull()

    await stores.passwordResetTokens.create({
      id: 'reset-1',
      provider: 'users',
      email: 'ava@example.com',
      tokenHash: 'sha256$reset',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(stores.passwordResetTokens.findById('reset-1')).resolves.toMatchObject({
      provider: 'users',
    })
    await stores.passwordResetTokens.create({
      id: 'reset-admin-1',
      provider: 'users',
      email: 'ava@example.com',
      table: 'admin_password_reset_tokens',
      tokenHash: 'sha256$reset',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(stores.passwordResetTokens.findLatestByEmail('users', 'ava@example.com', {
      table: 'admin_password_reset_tokens',
    })).resolves.toMatchObject({
      id: 'reset-admin-1',
      email: 'ava@example.com',
      table: 'admin_password_reset_tokens',
    })
    await expect(stores.passwordResetTokens.deleteByEmail('users', 'ava@example.com', {
      table: 'admin_password_reset_tokens',
    })).resolves.toBe(1)
    await stores.passwordResetTokens.create({
      id: 'reset-2',
      provider: 'users',
      email: 'ava@example.com',
      tokenHash: 'sha256$reset',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await stores.passwordResetTokens.delete('reset-2')
    await expect(stores.passwordResetTokens.findById('reset-2')).resolves.toBeNull()

    expect(holoRuntimeInternals.normalizeEmailVerificationTokenRecord({
      id: 'verify-row',
      provider: 'users',
      user_id: 'user-1',
      email: 'ava@example.com',
      token_hash: 'sha256$row',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    })).toMatchObject({
      id: 'verify-row',
      userId: 'user-1',
    })
    expect(holoRuntimeInternals.normalizePasswordResetTokenRecord({
      id: 'reset-row',
      email: 'ava@example.com',
      token_hash: 'sha256$row',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    })).toMatchObject({
      provider: 'users',
      table: undefined,
    })

    const frozenUser = Object.freeze({ id: 1 })
    expect(holoRuntimeInternals.markProviderUser('user-1', 'users')).toBe('user-1')
    expect(holoRuntimeInternals.markProviderUser(frozenUser, 'users')).toBe(frozenUser)
    expect(holoRuntimeInternals.fromHostedIdentityProviderValue('workos', 'google')).toBe('google')

    await writeFile(join(root, 'server/models/User.ts'), `
export default undefined
export const holoModelPendingSchema = true
`, 'utf8')
    const pendingProviders = await holoRuntimeInternals.createCoreAuthProviders(root, runtime.loadedConfig)
    const pendingAdapter = pendingProviders.users as {
      findById(id: string | number): Promise<unknown>
      findByCredentials(credentials: Record<string, unknown>): Promise<unknown>
      create(input: Record<string, unknown>): Promise<unknown>
      update(id: unknown, input: Record<string, unknown>): Promise<unknown>
      matchesUser(user: unknown): boolean
      getId(user: unknown): string | number
      getPasswordHash(user: unknown): string | null | undefined
      getEmailVerifiedAt(user: unknown): Date | string | null | undefined
      serialize(user: unknown): unknown
    }

    await expect(pendingAdapter.findById(1)).rejects.toThrow('pending generated schema output')
    await expect(pendingAdapter.findByCredentials({ email: 'ava@example.com' })).rejects.toThrow('pending generated schema output')
    await expect(pendingAdapter.create({ email: 'ava@example.com' })).rejects.toThrow('pending generated schema output')
    await expect(pendingAdapter.update(1, { email: 'ava@example.com' })).rejects.toThrow('pending generated schema output')
    expect(pendingAdapter.matchesUser({})).toBe(false)
    expect(() => pendingAdapter.getId({})).toThrow('pending generated schema output')
    expect(() => pendingAdapter.getPasswordHash({})).toThrow('pending generated schema output')
    expect(() => pendingAdapter.getEmailVerifiedAt({})).toThrow('pending generated schema output')
    expect(() => pendingAdapter.serialize({})).toThrow('pending generated schema output')
  })

  it('covers hosted identity fallback values and default auth-store branches', async () => {
    const root = await createProject({
      auth: true,
      session: 'database',
      workos: true,
    })
    const runtime = await createHolo(root, {
      envName: 'development',
    })
    await runtime.initialize()

    const schema = createSchemaService(DB.connection())
    await schema.createTable('auth_identities', (table) => {
      table.id()
      table.string('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.timestamps()
    })
    await schema.createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
    })
    await schema.createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('created_at')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamp('updated_at')
    })
    await schema.createTable('personal_access_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('name')
      table.string('token_hash').unique()
      table.json('abilities').default([])
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps()
    })

    const hostedIdentityStore = holoRuntimeInternals.createCoreHostedIdentityStore('workos')
    await expect(hostedIdentityStore.findByUserId('default', 'users', 999)).resolves.toBeNull()
    await DB.table('auth_identities').insert({
      user_id: 'user-1',
      provider: 'workos:default',
      provider_user_id: 'provider-user-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
    await expect(hostedIdentityStore.findByProviderUserId('default', 'provider-user-1')).resolves.toMatchObject({
      provider: 'default',
      providerUserId: 'provider-user-1',
      guard: 'web',
      authProvider: 'users',
      userId: 'user-1',
      profile: {},
    })
    await hostedIdentityStore.save({
      provider: 'default',
      providerUserId: 'provider-user-1',
      guard: 'admin',
      authProvider: 'users',
      userId: 'user-1',
      email: undefined,
      emailVerified: false,
      profile: {},
      linkedAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    })
    const updatedIdentityRows = await DB.table('auth_identities')
      .where('provider', 'workos:default')
      .where('provider_user_id', 'provider-user-1')
      .get<Record<string, unknown>>()
    expect(updatedIdentityRows).toHaveLength(1)
    expect(updatedIdentityRows[0]?.guard).toBe('admin')

    const stores = holoRuntimeInternals.createCoreAuthStores(runtime.loadedConfig)
    await DB.table('personal_access_tokens').insert({
      id: 'token-invalid',
      provider: 'users',
      user_id: 'user-1',
      name: 'browser',
      token_hash: 'sha256$hash',
      abilities: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await expect(stores.tokens.findById('token-invalid')).resolves.toMatchObject({
      abilities: [],
    })
    await expect(stores.tokens.deleteByUserId('users', 'missing')).resolves.toBe(0)
    await expect(stores.emailVerificationTokens.deleteByUserId('users', 'missing')).resolves.toBe(0)

    await stores.passwordResetTokens.create({
      id: 'reset-default',
      provider: 'users',
      email: 'ava@example.com',
      tokenHash: 'sha256$reset',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(stores.passwordResetTokens.findLatestByEmail('users', 'ava@example.com')).resolves.toMatchObject({
      id: 'reset-default',
      table: 'password_reset_tokens',
    })
    await stores.passwordResetTokens.delete('reset-default')
    await expect(stores.passwordResetTokens.deleteByEmail('users', 'missing@example.com')).resolves.toBe(0)
  })

  it('fails session store boot when the configured default store is unavailable', async () => {
    const root = await createProject({
      auth: true,
      session: 'database',
    })
    const runtime = await createHolo(root, {
      envName: 'development',
    })
    const sessionModule = await import('@holo-js/session')

    await expect(holoRuntimeInternals.createCoreSessionStores(root, {
      ...runtime.loadedConfig,
      session: {
        ...runtime.loadedConfig.session,
        driver: 'missing' as never,
      },
    }, sessionModule)).rejects.toThrow('runtime cannot boot it automatically')
  })

  it('resolves model entities through toAttributes() and throws when a configured model file is missing', async () => {
    const root = await createProject({
      auth: true,
    })
    await writeFile(join(root, 'server/models/User.ts'), `
export default {
  users: new Map(),
  nextId: 1,
  async find(id) {
    const record = this.users.get(Number(id))
    return record ? { toAttributes: () => ({ ...record }) } : null
  },
  where(column, value) {
    return {
      first: async () => {
        for (const record of this.users.values()) {
          if (record[column] === value) {
            return { toAttributes: () => ({ ...record }) }
          }
        }
        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: this.nextId++,
      ...values,
    }
    this.users.set(record.id, record)
    return { toAttributes: () => ({ ...record }) }
  },
  async update(id, values) {
    const current = this.users.get(Number(id))
    const record = {
      ...(current ?? { id: Number(id) }),
      ...values,
    }
    this.users.set(record.id, record)
    return { toAttributes: () => ({ ...record }) }
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()
    const registered = await runtime.auth?.register({
      name: 'Admin',
      email: 'admin@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).toMatchObject({
      id: 1,
      email: 'admin@example.com',
    })
    await runtime.shutdown()

    const noDefaultRoot = await createProject({
      auth: true,
    })
    await writeFile(join(noDefaultRoot, 'server/models/User.ts'), 'export const notDefault = true\n', 'utf8')
    await writeFile(join(noDefaultRoot, 'server/models/User.mts'), `
export default {
  users: new Map(),
  nextId: 1,
  async find(id) {
    return this.users.get(Number(id)) ?? null
  },
  where(column, value) {
    return {
      first: async () => {
        for (const record of this.users.values()) {
          if (record[column] === value) {
            return record
          }
        }
        return null
      },
    }
  },
  async create(values) {
    const record = {
      id: this.nextId++,
      ...values,
    }
    this.users.set(record.id, record)
    return record
  },
  async update(id, values) {
    const current = this.users.get(Number(id))
    const record = {
      ...(current ?? { id: Number(id) }),
      ...values,
    }
    this.users.set(record.id, record)
    return record
  },
}
`, 'utf8')

    const noDefaultRuntime = await createHolo(noDefaultRoot, {
      processEnv: process.env,
      preferCache: false,
    })
    await noDefaultRuntime.initialize()
    const plainRegistered = await noDefaultRuntime.auth?.register({
      name: 'Plain',
      email: 'plain@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(plainRegistered).toMatchObject({
      id: 1,
      email: 'plain@example.com',
    })
    await noDefaultRuntime.auth?.login({
      email: 'plain@example.com',
      password: 'supersecret',
    })
    expect(await noDefaultRuntime.auth?.check()).toBe(true)
    expect(await noDefaultRuntime.auth?.user()).toMatchObject({
      id: 1,
      email: 'plain@example.com',
    })
    expect(await noDefaultRuntime.auth?.refreshUser()).toMatchObject({
      id: 1,
      email: 'plain@example.com',
    })
    await noDefaultRuntime.auth?.logout()
    expect(await noDefaultRuntime.auth?.check()).toBe(false)
    await noDefaultRuntime.shutdown()

    const missingModelRoot = await createProject({
      auth: true,
    })
    await writeFile(join(missingModelRoot, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'MissingUser',
    },
  },
})
`, 'utf8')

    const missingRuntime = await createHolo(missingModelRoot, {
      processEnv: process.env,
      preferCache: false,
    })

    await expect(missingRuntime.initialize()).rejects.toThrow('Auth provider model "MissingUser" could not be resolved')
  })

  it('falls back to alternate auth provider extensions when missing imports are reported as unquoted urls', async () => {
    const root = await createProject({
      auth: true,
    })

    await rm(join(root, 'server/models/User.ts'))
    await writeFile(join(root, 'server/models/User.js'), `
const users = new Map()

export default {
  async find(id) {
    return users.get(id)
  },
  where(column, value) {
    return {
      async first() {
        for (const record of users.values()) {
          if (record?.[column] === value) {
            return record
          }
        }

        return undefined
      },
    }
  },
  async create(values) {
    return values
  },
  async update(_id, values) {
    return values
  },
}
`, 'utf8')

    const runtime = await createHolo(root, {
      processEnv: process.env,
      preferCache: false,
    })

    await runtime.initialize()

    const registered = await runtime.auth?.register({
      name: 'Fallback User',
      email: 'fallback@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })

    expect(registered).toMatchObject({
      email: 'fallback@example.com',
    })

    await runtime.shutdown()
  })
})
