import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSchemaService, DB } from '@holo-js/db'
import { createHolo, holoRuntimeInternals, resetHoloRuntime } from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []

async function createProject(options: {
  session?: 'file' | 'database' | false
  auth?: boolean
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

  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
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
    await expect(runtime.auth?.logoutAll()).resolves.toBeUndefined()
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
      environment: 'development',
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
    })

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
      environment: 'development',
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
    })

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

    const socialBindings = await holoRuntimeInternals.createCoreSocialBindings(runtime.loadedConfig, await import('../../session/src/index.ts'))

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

    const socialBindings = await holoRuntimeInternals.createCoreSocialBindings(runtime.loadedConfig, await import('../../session/src/index.ts'))
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
    }, await import('../../session/src/index.ts'))
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
    }, await import('../../session/src/index.ts'))
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

    const socialModule = await import('../../auth-social/src/index.ts')
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
    })
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
      environment: 'development',
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
      environment: 'development',
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

    const verificationToken = await runtime.auth?.verification.create(registered!)
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
})
