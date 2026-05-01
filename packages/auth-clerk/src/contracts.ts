import type { AuthEstablishedSession, AuthUserLike } from '@holo-js/auth'
import type { AuthClerkProviderConfig } from '@holo-js/config'

export interface ClerkEmailAddress {
  readonly id?: string
  readonly emailAddress: string
  readonly verificationStatus?: 'verified' | 'unverified' | 'pending'
}

export interface ClerkUserProfile {
  readonly id: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly firstName?: string
  readonly lastName?: string
  readonly name?: string
  readonly imageUrl?: string
  readonly primaryEmailAddressId?: string
  readonly emailAddresses?: readonly ClerkEmailAddress[]
  readonly raw?: unknown
}

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

export interface ClerkAuthenticationResult {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly status: ClerkSyncStatus
  readonly user: AuthUserLike
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

export interface ClerkAuthFacade {
  verifyRequest(request: Request, provider?: string): Promise<ClerkVerifiedSession | null>
  verifySession(token: string, provider?: string): Promise<ClerkVerifiedSession | null>
  syncIdentity(session: ClerkVerifiedSession, provider?: string): Promise<ClerkAuthenticationResult>
  authenticate(request: Request, provider?: string): Promise<ClerkAuthenticationResult | null>
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
