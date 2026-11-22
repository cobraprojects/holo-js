import { isDeepStrictEqual } from 'node:util'
import type { AuthSessionRecord, AuthenticatedAuthUser } from '../contracts'

export type SerializedAuthUser = AuthenticatedAuthUser & {
  readonly id: string | number
}

export type SessionIdentityPayload = {
  readonly revocation?: { readonly id: string, readonly generation: number }
  readonly guard: string
  readonly provider: string
  readonly userId: string | number
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
  readonly multiFactorRemember?: true
  readonly viaRemember?: true
}

export type SessionAuthPayloadMap = Readonly<Record<string, SessionAuthPayload>>

export function toSessionIdentityPayload(
  guard: string,
  provider: string,
  userId: string | number,
): SessionIdentityPayload {
  return Object.freeze({ guard, provider, userId })
}

export function toSessionPayload(
  guard: string,
  provider: string,
  user: SerializedAuthUser,
  impersonation?: SessionImpersonationPayload,
  multiFactorChallengeExpiresAt?: string,
  multiFactorRemember?: boolean,
): SessionAuthPayload {
  return Object.freeze({
    ...toSessionIdentityPayload(guard, provider, user.id),
    authenticatedAt: new Date().toISOString(),
    ...(impersonation ? { impersonation } : {}),
    ...(multiFactorChallengeExpiresAt ? { multiFactorChallengeExpiresAt } : {}),
    ...(multiFactorChallengeExpiresAt && multiFactorRemember ? { multiFactorRemember: true as const } : {}),
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
    && (!('viaRemember' in value) || value.viaRemember === undefined || value.viaRemember === true)
}

export function readSessionPayloads(record: AuthSessionRecord | null | undefined): SessionAuthPayloadMap | null {
  return record ? decodeSessionPayloads(record.data.auth) : null
}

export function decodeSessionPayloads(payload: unknown): SessionAuthPayloadMap | null {
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
  const { auth: _auth, ...nextData } = currentData
  const encoded = encodeSessionPayloads(payloads)
  return Object.freeze(encoded ? { ...nextData, auth: encoded } : nextData)
}

export function encodeSessionPayloads(payloads: SessionAuthPayloadMap): SessionAuthPayload | SessionAuthPayloadMap | undefined {
  const values = Object.values(payloads)
  if (values.length <= 1) return values[0]
  return Object.freeze(Object.fromEntries(values.map(value => [value.guard, value] as const)))
}

export function withoutGuards(payloads: SessionAuthPayloadMap, guardNames: readonly string[]): SessionAuthPayloadMap {
  return Object.freeze(Object.fromEntries(Object.entries(payloads).filter(([guardName]) => !guardNames.includes(guardName))))
}

export function withoutPayloads(payloads: SessionAuthPayloadMap, removed: readonly SessionAuthPayload[]): SessionAuthPayloadMap {
  return Object.freeze(Object.fromEntries(Object.entries(payloads).filter(([, payload]) => !removed.some(candidate => isDeepStrictEqual(candidate, payload)))))
}

export function stripImpersonation(payload: SessionAuthPayload): SessionIdentityPayload {
  return Object.freeze({
    ...toSessionIdentityPayload(payload.guard, payload.provider, payload.userId),
    ...(payload.revocation ? { revocation: payload.revocation } : {}),
  })
}
