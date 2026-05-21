import type { AuthenticatedAuthUser, AuthEstablishedSession, AuthLogoutResult } from '@holo-js/auth'
import type { AuthClerkProviderConfig } from '@holo-js/config'

export interface ClerkEmailAddress {
  readonly id?: string
  readonly emailAddress: string
  readonly verificationStatus?: 'verified' | 'unverified' | 'pending'
}

export interface ClerkUserProfile {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly firstName?: string
  readonly lastName?: string
  readonly name: string
  readonly imageUrl?: string
  readonly primaryEmailAddressId?: string
  readonly emailAddresses?: readonly ClerkEmailAddress[]
  readonly raw?: unknown
}

export type ClerkUserAttributeValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly ClerkUserAttributeValue[]
  | { readonly [key: string]: ClerkUserAttributeValue }

export type ClerkUserAttributes = Readonly<Record<string, ClerkUserAttributeValue>>

export interface ClerkVerifiedSession {
  readonly sessionId: string
  readonly user: ClerkUserProfile
  readonly accessToken?: string
  readonly actor?: {
    readonly id?: string
    readonly type?: string
  }
  readonly raw?: unknown
}

export interface ClerkLogoutSession {
  readonly provider: string
  readonly sessionId: string
}

export type ClerkCompleteAuthResult<TUser extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> =
  | Readonly<{
    readonly ok: true
    readonly provider: string
    readonly guard: string
    readonly authProvider: string
    readonly status: ClerkSyncStatus
    readonly user: ClerkAuthenticatedUser<TUser>
    readonly identity: HostedIdentityRecord
    readonly session: ClerkVerifiedSession
    readonly authSession?: AuthEstablishedSession
  }>
  | Readonly<{
    readonly ok: false
    readonly code: string
    readonly message: string
  }>

export type ClerkRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

export type ClerkRequestLike = {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: ClerkRequestHeaders
  readonly request?: Request
  readonly req?: Request | {
    readonly method?: string
    readonly url?: string
    readonly headers?: ClerkRequestHeaders
  }
  readonly node?: {
    readonly req?: {
      readonly method?: string
      readonly url?: string
      readonly headers?: ClerkRequestHeaders
    }
  }
  readonly web?: {
    readonly request?: Request
  }
}

export type ClerkRequestInput = Request | ClerkRequestLike

export type ClerkLogoutResult =
  | Readonly<{
    readonly ok: true
    readonly url: string
    readonly local: AuthLogoutResult
  }>
  | Readonly<{
    readonly ok: false
    readonly code: 'clerk_logout_failed' | 'clerk_session_missing'
    readonly message: string
    readonly local?: AuthLogoutResult
  }>

export interface ClerkVerifyRequestContext {
  readonly provider: string
  readonly request: Request
  readonly config: AuthClerkProviderConfig
}

export interface ClerkVerifySessionContext {
  readonly provider: string
  readonly token: string
  readonly config: AuthClerkProviderConfig
}

export interface ClerkProviderRuntime {
  verifyRequest?(context: ClerkVerifyRequestContext): Promise<ClerkVerifiedSession | null>
  verifySession?(context: ClerkVerifySessionContext): Promise<ClerkVerifiedSession | null>
}

export interface HostedIdentityRecord {
  readonly provider: string
  readonly providerUserId: string
  readonly guard: string
  readonly authProvider: string
  readonly userId: string | number
  readonly email?: string
  readonly emailVerified: boolean
  readonly profile: Readonly<Record<string, unknown>>
  readonly linkedAt: Date
  readonly updatedAt: Date
}

export interface HostedIdentityStore {
  findByProviderUserId(provider: string, providerUserId: string): Promise<HostedIdentityRecord | null>
  findByUserId(provider: string, authProvider: string, userId: string | number): Promise<HostedIdentityRecord | null>
  save(record: HostedIdentityRecord): Promise<void>
}

export type ClerkSyncStatus = 'created' | 'updated' | 'linked' | 'relinked'

export type ClerkAuthenticatedUser<TUser extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> =
  AuthenticatedAuthUser & TUser & {
    readonly id: string | number
  }

export interface ClerkAuthenticationResult<TUser extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly status: ClerkSyncStatus
  readonly user: ClerkAuthenticatedUser<TUser>
  readonly identity: HostedIdentityRecord
  readonly session: ClerkVerifiedSession
  readonly authSession?: AuthEstablishedSession
}

export interface ClerkAuthBindings {
  readonly providers: Readonly<Record<string, ClerkProviderRuntime>>
  readonly identityStore: HostedIdentityStore
}

export interface ConfigureClerkAuthRuntimeOptions {
  readonly providers?: Readonly<Record<string, ClerkProviderRuntime>>
  readonly identityStore?: HostedIdentityStore
}

type ClerkDefaultUserAttributes = {
  readonly email: string
  readonly name: string
}

export interface ClerkAuthFacade {
  loginWithClerk(request: ClerkRequestInput, options?: { readonly provider?: string }): Promise<Response>
  registerWithClerk(request: ClerkRequestInput, options?: { readonly provider?: string }): Promise<Response>
  logoutWithClerk(request: ClerkRequestInput, options?: { readonly provider?: string, readonly returnTo?: string }): Promise<ClerkLogoutResult>
  completeClerkAuth<TUserAttributes extends ClerkUserAttributes = ClerkUserAttributes>(
    request: ClerkRequestInput,
    options?: {
      readonly provider?: string
      readonly user?: (clerkUser: ClerkUserProfile) => TUserAttributes
    },
  ): Promise<ClerkCompleteAuthResult<TUserAttributes>>
  verifyRequest(request: ClerkRequestInput, provider?: string): Promise<ClerkVerifiedSession | null>
  verifySession(token: string, provider?: string): Promise<ClerkVerifiedSession | null>
  syncIdentity<TUserAttributes extends ClerkUserAttributes = ClerkDefaultUserAttributes>(
    session: ClerkVerifiedSession,
    provider?: string,
    options?: {
      readonly user?: (clerkUser: ClerkUserProfile) => TUserAttributes
    },
  ): Promise<ClerkAuthenticationResult<TUserAttributes>>
  authenticate(request: ClerkRequestInput, provider?: string): Promise<ClerkAuthenticationResult | null>
}

export class ClerkAuthConflictError extends Error {
  readonly code = 'clerk_identity_conflict'
  readonly provider: string
  readonly clerkUserId: string
  readonly email?: string

  constructor(options: {
    readonly provider: string
    readonly clerkUserId: string
    readonly email?: string
    readonly message: string
  }) {
    super(options.message)
    this.name = 'ClerkAuthConflictError'
    this.provider = options.provider
    this.clerkUserId = options.clerkUserId
    this.email = options.email
  }
}
