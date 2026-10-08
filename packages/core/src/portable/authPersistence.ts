import type * as AuthFeature from '@holo-js/auth'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { LoadedHoloConfig, HoloConfigMap } from '@holo-js/config'
import type { AuthMultiFactorVerificationState, EmailVerificationTokenStore, PasswordResetTokenStore } from '@holo-js/auth'
import { importBundledRuntimeModule } from '../runtimeModule'
import { createCoreSessionRevocationStore } from './authSessionRevocations'
import { column, normalizeDialectWriteValue, connectionAsyncContext, DB, Entity, ModelRepository, TableQueryBuilder, TransactionError, type DatabaseContext } from '@holo-js/db'

const authTimestampColumn = column.timestamp().toDefinition({ name: 'timestamp' })

export function serializeAuthTimestamp(value: Date, driver: string): string {
  return driver === 'mysql'
    ? String(normalizeDialectWriteValue('mysql', authTimestampColumn, value.toISOString()))
    : value.toISOString()
}

export function normalizeDateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

export function normalizeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function normalizeStoredUserId(value: unknown): string | number {
  return typeof value === 'number' ? value : String(value)
}

export type AccessTokenRecord = AuthFeature.PersonalAccessTokenRecord

export function normalizeAccessTokenRecord(row: Record<string, unknown>): AccessTokenRecord {
  const abilities = normalizeJsonValue(row.abilities)
  return Object.freeze({
    id: String(row.id),
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    name: String(row.name),
    abilities: Array.isArray(abilities) ? Object.freeze([...abilities]) as readonly string[] : Object.freeze([]),
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    lastUsedAt: row.last_used_at ? normalizeDateValue(row.last_used_at) : undefined,
    expiresAt: row.expires_at ? normalizeDateValue(row.expires_at) : null,
  })
}

export function serializeAccessTokenRecord(record: AccessTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    name: record.name,
    abilities: JSON.stringify(record.abilities),
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    last_used_at: record.lastUsedAt ? serializeAuthTimestamp(record.lastUsedAt, driver) : null,
    expires_at: record.expiresAt ? serializeAuthTimestamp(record.expiresAt, driver) : null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type EmailVerificationTokenRecord = AuthFeature.EmailVerificationTokenRecord

export function normalizeEmailVerificationTokenRecord(row: Record<string, unknown>): EmailVerificationTokenRecord {
  return Object.freeze({
    id: String(row.id),
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    email: String(row.email),
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    expiresAt: normalizeDateValue(row.expires_at),
  })
}

export function serializeEmailVerificationTokenRecord(record: EmailVerificationTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    email: record.email,
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    expires_at: serializeAuthTimestamp(record.expiresAt, driver),
    used_at: null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type PasswordResetTokenRecord = AuthFeature.PasswordResetTokenRecord

export function normalizePasswordResetTokenRecord(row: Record<string, unknown>): PasswordResetTokenRecord {
  return Object.freeze({
    id: String(row.id),
    provider: typeof row.provider === 'string' ? row.provider : 'users',
    email: String(row.email),
    table: typeof row.__holo_table === 'string' ? row.__holo_table : undefined,
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    expiresAt: normalizeDateValue(row.expires_at),
  })
}

export function serializePasswordResetTokenRecord(record: PasswordResetTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    email: record.email,
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    expires_at: serializeAuthTimestamp(record.expiresAt, driver),
    used_at: null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type MultiFactorCredentialRecord = AuthFeature.AuthMultiFactorCredentialRecord

export function normalizeMultiFactorCredentialRecord(row: Record<string, unknown>): MultiFactorCredentialRecord {
  const recoveryCodeHashes = normalizeJsonValue(row.recovery_code_hashes)
  return Object.freeze({
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    encryptedSecret: String(row.encrypted_secret),
    recoveryCodeHashes: Array.isArray(recoveryCodeHashes)
      ? Object.freeze(recoveryCodeHashes.filter((value): value is string => typeof value === 'string'))
      : Object.freeze([]),
    lastUsedCounter: row.last_used_counter === null || typeof row.last_used_counter === 'undefined'
      ? null
      : Number(row.last_used_counter),
    enabledAt: normalizeDateValue(row.enabled_at),
    updatedAt: normalizeDateValue(row.updated_at),
  })
}

export function serializeMultiFactorCredentialRecord(record: MultiFactorCredentialRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    provider: record.provider,
    user_id: String(record.userId),
    encrypted_secret: record.encryptedSecret,
    recovery_code_hashes: JSON.stringify(record.recoveryCodeHashes),
    last_used_counter: record.lastUsedCounter,
    enabled_at: serializeAuthTimestamp(record.enabledAt, driver),
    updated_at: serializeAuthTimestamp(record.updatedAt, driver),
  }
}

const HOLO_AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')
type CoreAuthProviderBinding = ReturnType<typeof AuthFeature.authRuntimeInternals.getRuntimeBindings>['providers'][string]

export async function createCoreAuthPersistence<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
) {
  const redemption = createAuthRedemptionContext()
  const providers = await createCoreAuthProviders(projectRoot, loadedConfig, redemption)
  return Object.freeze({
    providers,
    ...createCoreAuthStores(loadedConfig, redemption),
    sessionRevocations: createCoreSessionRevocationStore(),
  })
}

function createAuthRedemptionContext() {
  const repositories = new Map<string, () => object | null>()
  const active = new AsyncLocalStorage<{ readonly provider: string, readonly repository: ModelRepository }>()

  return {
    register(provider: string, repository: () => object | null): void {
      repositories.set(provider, repository)
    },
    repository(provider: string): ModelRepository | undefined {
      const context = active.getStore()
      return context?.provider === provider ? context.repository : undefined
    },
    async redeem<TResult>(
      provider: string,
      claim: (connection: DatabaseContext) => Promise<boolean>,
      operation: () => Promise<TResult>,
    ): Promise<TResult | null> {
      const connection = DB.connection()
      const repository = repositories.get(provider)?.()
      if (repository instanceof ModelRepository && repository.getConnection().getContextId() === connection.getContextId()) {
        return connection.writeTransaction(transaction => connectionAsyncContext.run({
          connectionName: transaction.getConnectionName(),
          connection: transaction,
        }, async () => {
          if (!await claim(transaction)) return null
          return active.run({ provider, repository }, operation)
        }))
      }

      if (connection.getScope().kind !== 'root') {
        throw new TransactionError('[Holo Auth] Token redemption for an external persistence context must run outside a database transaction.')
      }
      if (!await claim(connection)) return null
      return operation()
    },
  }
}

function authTokenExpiryPredicate(connection: DatabaseContext): string {
  const dialect = connection.getDialect().name
  if (dialect === 'sqlite') return "expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  if (dialect === 'postgres') return "expires_at > (clock_timestamp() AT TIME ZONE 'UTC')"
  return 'expires_at > CURRENT_TIMESTAMP(3)'
}

function getEntityAttributes(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    const candidate = value as {
      toAttributes?: () => Record<string, unknown>
      toJSON?: () => Record<string, unknown>
    }
    if (typeof candidate.toAttributes === 'function') {
      return candidate.toAttributes()
    }
    if (typeof candidate.toJSON === 'function') {
      const serialized = candidate.toJSON()
      if (serialized && typeof serialized === 'object') {
        return serialized
      }
    }

    return value as Record<string, unknown>
  }

  return {}
}
export function markProviderUser<T>(value: T, providerName: string): T {
  if (!value || typeof value !== 'object') {
    return value
  }

  try {
    Object.defineProperty(value, HOLO_AUTH_PROVIDER_MARKER, {
      value: providerName,
      enumerable: false,
      configurable: true,
    })
  } catch {
    return value
  }

  return value
}

function createCoreAuthStores<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
  redemption: ReturnType<typeof createAuthRedemptionContext>,
): { readonly tokens: AuthFeature.AuthTokenStore, readonly emailVerificationTokens: EmailVerificationTokenStore, readonly passwordResetTokens: PasswordResetTokenStore, readonly multiFactor: AuthFeature.AuthMultiFactorStore } {
  return Object.freeze({
    tokens: Object.freeze({
      async create(record: AuthFeature.PersonalAccessTokenRecord) {
        await DB.table('personal_access_tokens').insert(serializeAccessTokenRecord(record, DB.connection().getDriver()))
      },
      async findById(id: string) {
        const row = await DB.table('personal_access_tokens').find(id)
        return row ? normalizeAccessTokenRecord(row as Record<string, unknown>) : null
      },
      async listByUserId(provider: string, userId: string | number) {
        const rows = await DB.table('personal_access_tokens')
          .where('provider', provider)
          .where('user_id', String(userId))
          .get<Record<string, unknown>>()
        return Object.freeze(rows.map(row => normalizeAccessTokenRecord(row)))
      },
      async update(record: AuthFeature.PersonalAccessTokenRecord) {
        const payload = serializeAccessTokenRecord(record, DB.connection().getDriver())
        await DB.table('personal_access_tokens').where('id', String(payload.id)).update(payload)
      },
      async delete(id: string) {
        await DB.table('personal_access_tokens').where('id', id).delete()
      },
      async deleteByUserId(provider: string, userId: string | number, options: { readonly exceptId?: string } = {}) {
        const query = DB.table('personal_access_tokens')
          .where('provider', provider)
          .where('user_id', String(userId))
        const result = await (options.exceptId === undefined ? query : query.where('id', '!=', options.exceptId)).delete()
        return result.affectedRows ?? 0
      },
    }),
    emailVerificationTokens: Object.freeze({
      async redeem<TResult>(record: EmailVerificationTokenRecord, operation: () => Promise<TResult>): Promise<TResult | null> {
        return redemption.redeem(record.provider, async (connection) => {
          const claimed = await new TableQueryBuilder('email_verification_tokens', connection)
            .where('id', record.id)
            .where('provider', record.provider)
            .where('user_id', String(record.userId))
            .where('email', record.email)
            .where('token_hash', record.tokenHash)
            .where('created_at', serializeAuthTimestamp(record.createdAt, connection.getDriver()))
            .where('expires_at', serializeAuthTimestamp(record.expiresAt, connection.getDriver()))
            .where('expires_at', '>', serializeAuthTimestamp(new Date(), connection.getDriver()))
            .unsafeWhere(authTokenExpiryPredicate(connection), [])
            .whereNull('used_at')
            .delete()
          return claimed.affectedRows === 1
        }, operation)
      },
      async create(record: EmailVerificationTokenRecord) {
        await DB.table('email_verification_tokens').insert(serializeEmailVerificationTokenRecord(record, DB.connection().getDriver()))
      },
      async findById(id: string) {
        const row = await DB.table('email_verification_tokens')
          .where('id', id)
          .whereNull('used_at')
          .first<Record<string, unknown>>()
        return row ? normalizeEmailVerificationTokenRecord(row) : null
      },
      async delete(id: string) {
        await DB.table('email_verification_tokens').where('id', id).delete()
      },
      async deleteByUserId(provider: string, userId: string | number) {
        const result = await DB.table('email_verification_tokens')
          .where('provider', provider)
          .where('user_id', String(userId))
          .delete()
        return result.affectedRows ?? 0
      },
    }),
    passwordResetTokens: Object.freeze({
      async redeem<TResult>(record: PasswordResetTokenRecord, operation: () => Promise<TResult>): Promise<TResult | null> {
        const table = record.table ?? 'password_reset_tokens'
        if (!Object.values(loadedConfig.auth.passwords).some(broker => broker.provider === record.provider && broker.table === table)) return null
        return redemption.redeem(record.provider, async (connection) => {
          const claimed = await new TableQueryBuilder(table, connection)
            .where('id', record.id)
            .where('provider', record.provider)
            .where('email', record.email)
            .where('token_hash', record.tokenHash)
            .where('created_at', serializeAuthTimestamp(record.createdAt, connection.getDriver()))
            .where('expires_at', serializeAuthTimestamp(record.expiresAt, connection.getDriver()))
            .where('expires_at', '>', serializeAuthTimestamp(new Date(), connection.getDriver()))
            .unsafeWhere(authTokenExpiryPredicate(connection), [])
            .whereNull('used_at')
            .delete()
          return claimed.affectedRows === 1
        }, operation)
      },
      async create(record: PasswordResetTokenRecord) {
        await DB.table(record.table ?? 'password_reset_tokens').insert(serializePasswordResetTokenRecord(record, DB.connection().getDriver()))
      },
      async findById(id: string) {
        const tables = Array.from(new Set(
          Object.values(loadedConfig.auth.passwords).map(config => config.table),
        ))
        for (const table of tables) {
          const row = await DB.table(table)
            .where('id', id)
            .whereNull('used_at')
            .first<Record<string, unknown>>()
          if (row) {
            return normalizePasswordResetTokenRecord({
              ...row,
              __holo_table: table,
            })
          }
        }
        return null
      },
      async findLatestByEmail(provider: string, email: string, options?: { readonly table?: string }) {
        const table = options?.table ?? 'password_reset_tokens'
        const row = await DB.table(table)
          .where('provider', provider)
          .where('email', email)
          .latest('created_at')
          .first<Record<string, unknown>>()
        if (!row) {
          return null
        }

        return normalizePasswordResetTokenRecord({
          ...row,
          __holo_table: table,
        })
      },
      async delete(id: string, options?: { readonly table?: string }) {
        const table = options?.table ?? 'password_reset_tokens'
        await DB.table(table).where('id', id).delete()
      },
      async deleteByEmail(provider: string, email: string, options?: { readonly table?: string }) {
        const table = options?.table ?? 'password_reset_tokens'
        const result = await DB.table(table)
          .where('provider', provider)
          .where('email', email)
          .delete()
        return result.affectedRows ?? 0
      },
    }),
    multiFactor: Object.freeze({
      async find(provider: string, userId: string | number) {
        const row = await DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .first<Record<string, unknown>>()
        return row ? normalizeMultiFactorCredentialRecord(row) : null
      },
      async save(record: AuthFeature.AuthMultiFactorCredentialRecord) {
        await DB.table('auth_multi_factor_credentials').insert(serializeMultiFactorCredentialRecord(record, DB.connection().getDriver()))
      },
      async delete(provider: string, userId: string | number) {
        await DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .delete()
      },
      async advanceCounter(provider: string, userId: string | number, counter: number) {
        return DB.writeTransaction(async (transaction) => {
          let query = new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
          if (transaction.getCapabilities().lockForUpdate) query = query.lockForUpdate()
          const row = await query.first<Record<string, unknown>>()
          if (!row) return null
          const record = normalizeMultiFactorCredentialRecord(row)
          if (record.lastUsedCounter !== null && counter <= record.lastUsedCounter) return null
          await new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
            .update({ last_used_counter: counter, updated_at: serializeAuthTimestamp(new Date(), DB.connection().getDriver()) })
          return Object.freeze({ lastUsedCounter: counter, recoveryCodeHashes: record.recoveryCodeHashes })
        })
      },
      async consumeRecoveryCode(provider: string, userId: string | number, recoveryCodeHash: string) {
        return DB.writeTransaction(async (transaction) => {
          let query = new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
          if (transaction.getCapabilities().lockForUpdate) query = query.lockForUpdate()
          const row = await query.first<Record<string, unknown>>()
          if (!row) return null
          const record = normalizeMultiFactorCredentialRecord(row)
          const index = record.recoveryCodeHashes.indexOf(recoveryCodeHash)
          if (index < 0) return null
          const hashes = record.recoveryCodeHashes.filter((_, candidateIndex) => candidateIndex !== index)
          await new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
            .update({ recovery_code_hashes: JSON.stringify(hashes), updated_at: serializeAuthTimestamp(new Date(), DB.connection().getDriver()) })
          return Object.freeze({ lastUsedCounter: record.lastUsedCounter, recoveryCodeHashes: Object.freeze(hashes) })
        })
      },
      async replaceRecoveryCodes(provider: string, userId: string | number, recoveryCodeHashes: readonly string[], updatedAt: Date, verification: AuthMultiFactorVerificationState) {
        let query = DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .where('recovery_code_hashes', JSON.stringify(verification.recoveryCodeHashes))
        query = verification.lastUsedCounter === null
          ? query.whereNull('last_used_counter')
          : query.where('last_used_counter', verification.lastUsedCounter)
        const result = await query.update({
          recovery_code_hashes: JSON.stringify(recoveryCodeHashes),
          updated_at: serializeAuthTimestamp(updatedAt, DB.connection().getDriver()),
        })
        return (result.affectedRows ?? 0) > 0
      },
    }),
  })
}

async function resolveAuthProviderRuntime<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  modelName: string,
): Promise<unknown> {
  const modelsRoot = resolve(projectRoot, loadedConfig.app.paths.models)
  for (const extension of ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs']) {
    const candidate = resolve(modelsRoot, `${modelName}${extension}`)
    try {
      const moduleValue = await importBundledRuntimeModule(projectRoot, candidate) as {
        default?: unknown
        holoModelPendingSchema?: boolean
      }
      if ('default' in moduleValue) {
        return moduleValue
      }
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT'
      ) {
        continue
      }
      if (error instanceof Error && /Could not resolve|Cannot find module|ENOENT/.test(error.message)) {
        const normalizedCandidate = candidate.replaceAll('\\', '/')
        const normalizedMessage = error.message.replaceAll('\\', '/')
        const escapedCandidate = normalizedCandidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const missingModulePattern = new RegExp(`(?:Cannot find module|Could not resolve|Failed to load url)\\s+['"]${escapedCandidate}['"]`)
        const enotentPathMatch = normalizedMessage.match(/ENOENT.*?(?:open|scandir|stat).*?['"]([^'"]+)['"]/)
        if (
          missingModulePattern.test(normalizedMessage)
          || enotentPathMatch?.[1]?.endsWith(normalizedCandidate)
        ) {
          continue
        }
      }
      throw error
    }
    }

  throw new Error(`[@holo-js/core] Auth provider model "${modelName}" could not be resolved from ${modelsRoot}.`)
}

async function createCoreAuthProviders<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  redemption: ReturnType<typeof createAuthRedemptionContext>,
): Promise<Readonly<Record<string, CoreAuthProviderBinding>>> {
  const providers = Object.entries(loadedConfig.auth.providers)

  return Object.freeze(Object.fromEntries(await Promise.all(providers.map(async ([providerName, providerConfig]) => {
    type AuthModelQuery = {
      where(column: string, value: unknown): AuthModelQuery
      first(): Promise<Record<string, unknown> | null | undefined>
    }

    type AuthModelEntity = {
      forceFill?(values: Record<string, unknown>): unknown
    }

    type AuthModelRepository = {
      saveEntity?(entity: unknown, internalColumns?: ReadonlySet<string>): Promise<Record<string, unknown>>
      delete?(id: unknown): Promise<void>
    }

    const resolvedModule = await resolveAuthProviderRuntime(projectRoot, loadedConfig, providerConfig.model) as {
      default?: unknown
      holoModelPendingSchema?: boolean
      prepareAuthCreateInput?: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>
      prepareAuthUpdateInput?: (
        user: unknown,
        input: Readonly<Record<string, unknown>>,
      ) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>
    }
    const model = resolvedModule.default as {
      definition?: {
        readonly table?: {
          readonly columns?: Readonly<Record<string, unknown>>
        }
        readonly guarded?: readonly string[]
      }
      query?(): AuthModelQuery
      find(value: unknown): Promise<Record<string, unknown> | null | undefined>
      where(column: string, value: unknown): AuthModelQuery
      getRepository?(): AuthModelRepository
      create(values: Record<string, unknown>): Promise<Record<string, unknown>>
      update(id: unknown, values: Record<string, unknown>): Promise<Record<string, unknown>>
      delete?(id: unknown): Promise<void>
    }
    const throwPendingSchema = (): never => {
      throw new Error(
        `[@holo-js/core] Auth provider model "${providerConfig.model}" is pending generated schema output. `
        + 'Run the schema generator before using auth.',
      )
    }

    if (typeof model === 'undefined' && resolvedModule.holoModelPendingSchema === true) {
      const pendingAdapter: CoreAuthProviderBinding = {
        async findById() {
          return throwPendingSchema()
        },
        async findByCredentials() {
          return throwPendingSchema()
        },
        async create() {
          return throwPendingSchema()
        },
        async update() {
          return throwPendingSchema()
        },
        matchesUser() {
          return false
        },
        getId() {
          return throwPendingSchema()
        },
        getPasswordHash() {
          return throwPendingSchema()
        },
        getEmailVerifiedAt() {
          return throwPendingSchema()
        },
        serialize() {
          return throwPendingSchema()
        },
      }

      return [providerName, pendingAdapter] as const
    }

    const sanitizeAuthWriteInput = (
      input: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
      const definition = model.definition
      const knownColumns = new Set(Object.keys(definition?.table?.columns ?? {}))
      const guarded = new Set(definition?.guarded ?? [])
      const hasKnownColumns = knownColumns.size > 0
      const output: Record<string, unknown> = {}

      for (const [column, value] of Object.entries(input)) {
        if (hasKnownColumns && !knownColumns.has(column)) {
          continue
        }

        if (guarded.has('*') || guarded.has(column)) {
          continue
        }

        output[column] = value
      }

      return output
    }

    const prepareAuthCreateInput = async (input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const sanitizedInput = sanitizeAuthWriteInput(input)
      if (typeof resolvedModule.prepareAuthCreateInput !== 'function') {
        return sanitizedInput
      }

      return sanitizeAuthWriteInput(await resolvedModule.prepareAuthCreateInput(sanitizedInput))
    }

    const prepareAuthUpdateInput = async (
      user: unknown,
      input: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const sanitizedInput = sanitizeAuthWriteInput(input)
      if (typeof resolvedModule.prepareAuthUpdateInput !== 'function') {
        return sanitizedInput
      }

      return sanitizeAuthWriteInput(await resolvedModule.prepareAuthUpdateInput(user, sanitizedInput))
    }

    redemption.register(providerName, () => model.getRepository?.() ?? null)

    const saveAuthEntity = async (entity: unknown, values: Record<string, unknown>) => {
      const repository = typeof model.getRepository === 'function'
        ? model.getRepository()
        : null

      if (
        repository
        && typeof repository.saveEntity === 'function'
        && entity
        && typeof entity === 'object'
        && typeof (entity as AuthModelEntity).forceFill === 'function'
      ) {
        ;(entity as AuthModelEntity).forceFill!(values)
        return repository.saveEntity(entity, new Set(Object.keys(values)))
      }

      return null
    }

    const adapter: CoreAuthProviderBinding = {
      async findById(id: string | number) {
        const repository = redemption.repository(providerName)
        const resolved = repository ? await repository.find(id) : await model.find(id)
        return resolved ? markProviderUser(resolved, providerName) : null
      },
      async findByCredentials(credentials: Readonly<Record<string, unknown>>) {
        const entries = Object.entries(credentials)
        if (entries.length === 0) {
          return null
        }

        const repository = redemption.repository(providerName)
        if (repository || typeof model.query === 'function') {
          let query = repository ? repository.query() : model.query!()
          for (const [column, value] of entries) {
            query = query.where(column, value)
          }
          const resolved = await query.first()
          return resolved ? markProviderUser(resolved, providerName) : null
        }

        const firstEntry = entries[0]
        if (!firstEntry) return null
        let query = model.where(firstEntry[0], firstEntry[1])
        for (const [column, value] of entries.slice(1)) {
          if (typeof query.where !== 'function') {
            break
          }
          query = query.where(column, value)
        }
        const resolved = await query.first()
        return resolved ? markProviderUser(resolved, providerName) : null
      },
      async create(input: Readonly<Record<string, unknown>>) {
        const values = await prepareAuthCreateInput(input)
        const repository = typeof model.getRepository === 'function'
          ? model.getRepository()
          : null
        const entity = repository && typeof repository.saveEntity === 'function'
          ? new Entity(repository as never, values as never, false)
          : null
        const persisted = entity ? await saveAuthEntity(entity, values) : null

        return markProviderUser(persisted ?? await model.create(values), providerName)
      },
      async delete(id: string | number) {
        const repository = typeof model.getRepository === 'function'
          ? model.getRepository()
          : null
        if (repository && typeof repository.delete === 'function') {
          await repository.delete(id)
          return
        }

        if (typeof model.delete === 'function') {
          await model.delete(id)
          return
        }

        const existing = typeof model.find === 'function'
          ? await model.find(id)
          : null
        if (existing && typeof existing === 'object' && 'delete' in existing && typeof existing.delete === 'function') {
          await existing.delete()
        }
      },
      async update(user: unknown, input: Readonly<Record<string, unknown>>) {
        const id = getEntityAttributes(user).id
        const values = await prepareAuthUpdateInput(user, input)
        const repository = redemption.repository(providerName)
        if (repository) {
          const existing = await repository.findOrFail(id)
          existing.forceFill(values)
          return markProviderUser(await repository.saveEntity(existing, new Set(Object.keys(values))), providerName)
        }

        const existing = typeof model.find === 'function' ? await model.find(id) : null
        const persisted = existing ? await saveAuthEntity(existing, values) : null

        return markProviderUser(persisted ?? await model.update(id, values), providerName)
      },
      matchesUser(user: unknown) {
        if (typeof model === 'function' && user instanceof model) {
          return true
        }

        if (
          user
          && typeof user === 'object'
          && (user as Record<PropertyKey, unknown>)[HOLO_AUTH_PROVIDER_MARKER] === providerName
        ) {
          return true
        }

        return (getEntityAttributes(user) as Record<PropertyKey, unknown>)[HOLO_AUTH_PROVIDER_MARKER] === providerName
      },
      getId(user: unknown) {
        return getEntityAttributes(user).id as string | number
      },
      getPasswordHash(user: unknown) {
        const value = getEntityAttributes(user).password
        return typeof value === 'string' ? value : null
      },
      getEmailVerifiedAt(user: unknown) {
        const value = getEntityAttributes(user).email_verified_at
        return value instanceof Date || typeof value === 'string' ? value : null
      },
      serialize(user: unknown) {
        const serialized = user && typeof user === 'object' && typeof (user as { toJSON?: () => unknown }).toJSON === 'function'
          ? (user as { toJSON(): Record<string, unknown> }).toJSON()
          : { ...getEntityAttributes(user) }
        Object.defineProperty(serialized, HOLO_AUTH_PROVIDER_MARKER, {
          value: providerName,
          enumerable: false,
          configurable: true,
        })
        return serialized
      },
      }

    return [providerName, adapter] as const
  }))))
}
