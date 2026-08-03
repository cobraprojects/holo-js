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

export type AccessTokenRecord = {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly name: string
  readonly abilities: readonly string[]
  readonly tokenHash: string
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
}

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

export function serializeAccessTokenRecord(record: AccessTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    name: record.name,
    abilities: JSON.stringify(record.abilities),
    token_hash: record.tokenHash,
    created_at: record.createdAt.toISOString(),
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    expires_at: record.expiresAt?.toISOString() ?? null,
    updated_at: new Date().toISOString(),
  }
}

export type EmailVerificationTokenRecord = {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

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

export function serializeEmailVerificationTokenRecord(record: EmailVerificationTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    email: record.email,
    token_hash: record.tokenHash,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    used_at: null,
    updated_at: new Date().toISOString(),
  }
}

export type PasswordResetTokenRecord = {
  readonly id: string
  readonly provider: string
  readonly email: string
  readonly table?: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

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

export function serializePasswordResetTokenRecord(record: PasswordResetTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    email: record.email,
    token_hash: record.tokenHash,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    used_at: null,
    updated_at: new Date().toISOString(),
  }
}

export type MultiFactorCredentialRecord = {
  readonly provider: string
  readonly userId: string | number
  readonly encryptedSecret: string
  readonly recoveryCodeHashes: readonly string[]
  readonly lastUsedCounter: number | null
  readonly enabledAt: Date
  readonly updatedAt: Date
}

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

export function serializeMultiFactorCredentialRecord(record: MultiFactorCredentialRecord): Record<string, unknown> {
  return {
    provider: record.provider,
    user_id: String(record.userId),
    encrypted_secret: record.encryptedSecret,
    recovery_code_hashes: JSON.stringify(record.recoveryCodeHashes),
    last_used_counter: record.lastUsedCounter,
    enabled_at: record.enabledAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  }
}
