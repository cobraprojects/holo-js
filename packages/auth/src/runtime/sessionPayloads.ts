import type { AuthSessionRecord, AuthenticatedAuthUser } from '../contracts'

export type SerializedAuthUser = AuthenticatedAuthUser & {
  readonly id: string | number
}

export type SessionIdentityPayload = {
  readonly guard: string
  readonly provider: string
  readonly userId: string | number
  readonly user: SerializedAuthUser
}

export type SessionImpersonationPayload = {
  readonly actor: SessionIdentityPayload
  readonly original?: SessionIdentityPayload
  readonly startedAt: string
}

export type SessionAuthPayload = SessionIdentityPayload & {
  readonly authenticatedAt: string
  readonly impersonation?: SessionImpersonationPayload
  readonly multiFactorChallengeExpiresAt?: string
}

export type SessionAuthPayloadMap = Readonly<Record<string, SessionAuthPayload>>

export function toSessionIdentityPayload(
  guard: string,
  provider: string,
  user: SerializedAuthUser,
): SessionIdentityPayload {
  return Object.freeze({ guard, provider, userId: user.id, user })
}

export function toSessionPayload(
  guard: string,
  provider: string,
  user: SerializedAuthUser,
  impersonation?: SessionImpersonationPayload,
  multiFactorChallengeExpiresAt?: string,
): SessionAuthPayload {
  return Object.freeze({
    ...toSessionIdentityPayload(guard, provider, user),
    authenticatedAt: new Date().toISOString(),
    ...(impersonation ? { impersonation } : {}),
    ...(multiFactorChallengeExpiresAt ? { multiFactorChallengeExpiresAt } : {}),
  })
}

function isSessionIdentityPayload(value: unknown): value is SessionIdentityPayload {
  return value !== null
    && typeof value === 'object'
    && 'guard' in value
    && typeof value.guard === 'string'
    && 'provider' in value
    && typeof value.provider === 'string'
    && 'userId' in value
    && (typeof value.userId === 'string' || typeof value.userId === 'number')
    && 'user' in value
    && value.user !== null
    && typeof value.user === 'object'
}

function isSessionImpersonationPayload(value: unknown): value is SessionImpersonationPayload {
  return value !== null
    && typeof value === 'object'
    && 'actor' in value
    && isSessionIdentityPayload(value.actor)
    && (!('original' in value) || typeof value.original === 'undefined' || isSessionIdentityPayload(value.original))
    && 'startedAt' in value
    && typeof value.startedAt === 'string'
}

function isSessionAuthPayload(value: unknown): value is SessionAuthPayload {
  return isSessionIdentityPayload(value)
    && 'authenticatedAt' in value
    && typeof value.authenticatedAt === 'string'
    && Number.isFinite(Date.parse(value.authenticatedAt))
    && (!('impersonation' in value) || typeof value.impersonation === 'undefined' || isSessionImpersonationPayload(value.impersonation))
    && (!('multiFactorChallengeExpiresAt' in value) || typeof value.multiFactorChallengeExpiresAt === 'string')
}

export function readSessionPayloads(record: AuthSessionRecord | null | undefined): SessionAuthPayloadMap | null {
  if (!record) return null
  const payload = record.data.auth
  if (!payload) return null
  if (isSessionAuthPayload(payload)) return Object.freeze({ [payload.guard]: payload })
  if (typeof payload !== 'object') return null
  const entries = Object.entries(payload)
    .filter((entry): entry is [string, SessionAuthPayload] => isSessionAuthPayload(entry[1]))
    .map(([, value]) => [value.guard, value] as const)
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : null
}

export function readSessionPayload(
  record: AuthSessionRecord | null | undefined,
  guardName?: string,
): SessionAuthPayload | null {
  const payloads = readSessionPayloads(record)
  if (!payloads) return null
  return guardName ? payloads[guardName] ?? null : Object.values(payloads)[0] ?? null
}

export function resolveSessionPayloadProvider(payload: SessionAuthPayload): string {
  const source = payload as SessionAuthPayload & { readonly clerk?: unknown, readonly workos?: unknown }
  if (source.workos && typeof source.workos === 'object') return 'workos'
  if (source.clerk && typeof source.clerk === 'object') return 'clerk'
  return payload.provider
}

export function writeSessionPayloads(
  currentData: Readonly<Record<string, unknown>>,
  payloads: SessionAuthPayloadMap,
): Readonly<Record<string, unknown>> {
  const nextData = { ...currentData } as Record<string, unknown>
  const values = Object.values(payloads)
  if (values.length === 0) {
    delete nextData.auth
    return Object.freeze(nextData)
  }
  if (values.length === 1) {
    nextData.auth = values[0]
    return Object.freeze(nextData)
  }
  nextData.auth = Object.freeze(Object.fromEntries(values.map(value => [value.guard, value] as const)))
  return Object.freeze(nextData)
}

export function stripImpersonation(payload: SessionAuthPayload): SessionIdentityPayload {
  return toSessionIdentityPayload(payload.guard, payload.provider, payload.user)
}
