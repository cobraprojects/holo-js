import type { AuthRuntimeContext, AuthSessionIdentity, AuthSessionRevocationState, AuthSessionRevocationStore } from '../contracts'
import { authRequestScope } from './context'
import type { SessionAuthPayload, SessionAuthPayloadMap } from './sessionPayloads'

const requestReads = new WeakMap<object, WeakMap<AuthSessionRevocationStore, Map<string, Promise<AuthSessionRevocationState>>>>()

function identityKey(identity: AuthSessionIdentity): string {
  return JSON.stringify([identity.provider, String(identity.userId)])
}

function scopedReads(context: AuthRuntimeContext, store: AuthSessionRevocationStore): Map<string, Promise<AuthSessionRevocationState>> {
  const scope = authRequestScope(context)
  if (!scope) return new Map()
  let stores = requestReads.get(scope)
  if (!stores) {
    stores = new WeakMap()
    requestReads.set(scope, stores)
  }
  let reads = stores.get(store)
  if (!reads) {
    reads = new Map()
    stores.set(store, reads)
  }
  return reads
}

export async function readSessionRevocations(
  store: AuthSessionRevocationStore,
  context: AuthRuntimeContext,
  identities: readonly AuthSessionIdentity[],
  fresh = false,
): Promise<ReadonlyMap<string, AuthSessionRevocationState>> {
  const reads = scopedReads(context, store)
  const distinct = new Map(identities.map(identity => [identityKey(identity), identity]))
  const missing = [...distinct.values()].filter(identity => fresh || !reads.has(identityKey(identity)))
  if (missing.length) {
    const batch = store.readMany(missing).then(states => new Map(states.map(state => [identityKey(state), state])))
    for (const identity of missing) {
      reads.set(identityKey(identity), batch.then(states => states.get(identityKey(identity)) ?? { ...identity, generation: 0 }))
    }
  }
  return new Map(await Promise.all([...distinct.entries()].map(async ([key, identity]) => [key, await reads.get(key) ?? { ...identity, generation: 0 }] as const)))
}

export function sessionIdentityValid(payload: SessionAuthPayload, states: ReadonlyMap<string, AuthSessionRevocationState>): boolean {
  const metadata = payload.revocation
  if (!metadata || typeof metadata.id !== 'string' || !metadata.id || !Number.isSafeInteger(metadata.generation) || metadata.generation < 0) return false
  const state = states.get(identityKey(payload))
  return Boolean(state && (metadata.generation === state.generation || metadata.id === state.retainedSessionId))
}

export async function validSessionPayloads(
  store: AuthSessionRevocationStore,
  context: AuthRuntimeContext,
  payloads: SessionAuthPayloadMap,
): Promise<SessionAuthPayloadMap> {
  const states = await readSessionRevocations(store, context, Object.values(payloads))
  return Object.fromEntries(Object.entries(payloads).filter(([, payload]) => sessionIdentityValid(payload, states)))
}

export async function loginRevocationMetadata(
  store: AuthSessionRevocationStore,
  context: AuthRuntimeContext,
  identity: AuthSessionIdentity,
  payloads: SessionAuthPayloadMap,
): Promise<NonNullable<SessionAuthPayload['revocation']>> {
  const states = await readSessionRevocations(store, context, [identity], true)
  return {
    id: Object.values(payloads).find(payload => payload.revocation)?.revocation?.id ?? crypto.randomUUID(),
    generation: states.get(identityKey(identity))?.generation ?? 0,
  }
}

export function clearSessionRevocationReads(context: AuthRuntimeContext): void {
  const scope = authRequestScope(context)
  if (scope) requestReads.delete(scope)
}
