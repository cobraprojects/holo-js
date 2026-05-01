import type { AuthEstablishedSession, AuthUserLike } from '@holo-js/auth'
import type { AuthWorkosProviderConfig } from '@holo-js/config'

export interface WorkosIdentityProfile {
  readonly id: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly firstName?: string
  readonly lastName?: string
  readonly name?: string
  readonly avatar?: string
  readonly organizationId?: string
  readonly raw?: unknown
}

export interface WorkosVerifiedSession {
  readonly sessionId: string
  readonly identity: WorkosIdentityProfile
  readonly accessToken?: string
  readonly expiresAt?: Date
  readonly raw?: unknown
}

export interface WorkosVerifyRequestContext {
  readonly provider: string
  readonly request: Request
  readonly config: AuthWorkosProviderConfig
}

export interface WorkosVerifySessionContext {
  readonly provider: string
  readonly token: string
  readonly config: AuthWorkosProviderConfig
}

export interface WorkosProviderRuntime {
  verifyRequest?(context: WorkosVerifyRequestContext): Promise<WorkosVerifiedSession | null>
  verifySession?(context: WorkosVerifySessionContext): Promise<WorkosVerifiedSession | null>
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

export type WorkosSyncStatus = 'created' | 'updated' | 'linked' | 'relinked'

export interface WorkosAuthenticationResult {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly status: WorkosSyncStatus
  readonly user: AuthUserLike
  readonly identity: HostedIdentityRecord
  readonly session: WorkosVerifiedSession
  readonly authSession?: AuthEstablishedSession
}

export interface WorkosAuthBindings {
  readonly providers: Readonly<Record<string, WorkosProviderRuntime>>
  readonly identityStore: HostedIdentityStore
}

export interface ConfigureWorkosAuthRuntimeOptions {
  readonly providers?: Readonly<Record<string, WorkosProviderRuntime>>
  readonly identityStore?: HostedIdentityStore
}

export interface WorkosAuthFacade {
  verifyRequest(request: Request, provider?: string): Promise<WorkosVerifiedSession | null>
  verifySession(token: string, provider?: string): Promise<WorkosVerifiedSession | null>
  syncIdentity(session: WorkosVerifiedSession, provider?: string): Promise<WorkosAuthenticationResult>
  authenticate(request: Request, provider?: string): Promise<WorkosAuthenticationResult | null>
}

export class WorkosAuthConflictError extends Error {
  readonly code = 'workos_identity_conflict'
  readonly provider: string
  readonly workosUserId: string
  readonly email?: string

  constructor(options: {
    readonly provider: string
    readonly workosUserId: string
    readonly email?: string
    readonly message: string
  }) {
    super(options.message)
    this.name = 'WorkosAuthConflictError'
    this.provider = options.provider
    this.workosUserId = options.workosUserId
    this.email = options.email
  }
}
