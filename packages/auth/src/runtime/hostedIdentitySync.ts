import type { AuthHostedIdentityRecord, AuthHostedIdentityStore } from '../config'
import type { authRuntimeInternals } from '../runtime'

type LocalUser = Record<string, unknown>
type SyncStatus = 'created' | 'linked' | 'updated' | 'relinked'

type HostedIdentitySyncInput = {
  readonly provider: string
  readonly providerUserId: string
  readonly adapter: Pick<ReturnType<typeof authRuntimeInternals.getRuntimeBindings>['providers'][string],
    'findById' | 'findByCredentials' | 'create' | 'update' | 'getId' | 'delete'>
  readonly identityStore: AuthHostedIdentityStore
  readonly ownership: 'serialized-claim' | 'save'
  readonly verifiedEmail?: string
  readonly email?: string
  readonly errorPrefix: string
  readonly identityLabel: string
  readonly createUserInput: () => Readonly<Record<string, unknown>>
  readonly updateUserInput: () => Readonly<Record<string, unknown>>
  readonly createIdentity: (userId: string | number, previous?: AuthHostedIdentityRecord) => AuthHostedIdentityRecord
  readonly conflict: (email: string, collision: boolean) => Error
}

type HostedIdentitySyncResult = {
  readonly status: SyncStatus
  readonly user: LocalUser
  readonly identity: AuthHostedIdentityRecord
}

const identitySyncLocks = new Map<string, Promise<void>>()

async function withIdentitySyncLock<TResult>(
  key: string,
  callback: () => Promise<TResult>,
): Promise<TResult> {
  const previous = identitySyncLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => gate)
  identitySyncLocks.set(key, current)
  await previous

  try {
    return await callback()
  } finally {
    release()
    if (identitySyncLocks.get(key) === current) {
      identitySyncLocks.delete(key)
    }
  }
}

function requireUserRecord(user: unknown, input: HostedIdentitySyncInput, operation: string): LocalUser {
  if (!user || typeof user !== 'object') {
    throw new Error(`${input.errorPrefix} ${operation}`)
  }
  return user as LocalUser
}

function requireUserId(user: LocalUser, input: HostedIdentitySyncInput, operation: string): string | number {
  const id = input.adapter.getId(user)
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error(`${input.errorPrefix} ${operation} local users must expose a serializable id.`)
  }
  return id
}

async function findUserByEmail(email: string, input: HostedIdentitySyncInput): Promise<LocalUser | null> {
  const user = await input.adapter.findByCredentials({ email: email.trim() })
  return user ? requireUserRecord(user, input, 'Auth provider lookups must return object users.') : null
}

async function updateLocalUser(user: LocalUser, input: HostedIdentitySyncInput): Promise<{ user: LocalUser, changed: boolean }> {
  const attributes = input.updateUserInput()
  const changed = Object.entries(attributes).some(([key, value]) => key === 'email_verified_at'
    ? value instanceof Date && !user.email_verified_at
    : !Object.is(value, user[key]))
  if (!changed) {
    return { user, changed: false }
  }
  if (!input.adapter.update) {
    throw new Error(`${input.errorPrefix} Auth provider adapters must implement update() to persist profile changes.`)
  }
  return {
    user: requireUserRecord(await input.adapter.update(user, attributes), input, 'Auth provider updates must return object users.'),
    changed: true,
  }
}

async function synchronize(input: HostedIdentitySyncInput): Promise<HostedIdentitySyncResult> {
  const { adapter, identityStore } = input
  const previous = await identityStore.findByProviderUserId(input.provider, input.providerUserId)
  const found = previous ? await adapter.findById(previous.userId) : null
  let user = found ? requireUserRecord(found, input, 'Auth provider lookups must return object users.') : null
  let status: SyncStatus

  if (user) {
    const userId = requireUserId(user, input, 'Linked')
    const matched = input.email ? await findUserByEmail(input.email, input) : null
    if (matched && requireUserId(matched, input, 'Matched') !== userId) {
      throw input.conflict(input.email!, true)
    }
    const updated = await updateLocalUser(user, input)
    user = updated.user
    status = updated.changed ? 'updated' : 'linked'
  } else {
    if (input.verifiedEmail && await findUserByEmail(input.verifiedEmail, input)) {
      throw input.conflict(input.verifiedEmail, false)
    }
    user = requireUserRecord(await adapter.create(input.createUserInput()), input, 'Auth provider create() must return an object user.')
    if (previous) {
      user = (await updateLocalUser(user, input)).user
    }
    status = previous ? 'relinked' : 'created'
  }

  const identity = input.createIdentity(requireUserId(user, input, status === 'created' ? 'Created' : status === 'relinked' ? 'Relinked' : 'Updated'), previous ?? undefined)
  if (previous || input.ownership === 'save' || !identityStore.claim) {
    await identityStore.save(identity)
    return { status, user, identity }
  }

  const claimedIdentity = await identityStore.claim(identity)
  if (String(claimedIdentity.userId) === String(identity.userId)) {
    return { status: 'created', user, identity: claimedIdentity }
  }
  const claimedUser = requireUserRecord(
    await adapter.findById(claimedIdentity.userId),
    input,
    `Claimed ${input.identityLabel} identities must reference an existing local user.`,
  )
  if (adapter.delete) {
    await adapter.delete(identity.userId)
  }
  return { status: 'linked', user: claimedUser, identity: claimedIdentity }
}

export async function syncHostedIdentity(input: HostedIdentitySyncInput): Promise<HostedIdentitySyncResult> {
  if (input.ownership === 'save') {
    return await synchronize(input)
  }
  return await withIdentitySyncLock(JSON.stringify([input.provider, input.providerUserId]), () => synchronize(input))
}
