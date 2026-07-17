import type { AuthenticatedAuthUser, AuthEstablishedSession, AuthFieldErrors, AuthLogoutResult, AuthResult } from '@holo-js/auth'
import type { NormalizedAuthWorkosProviderConfig } from '@holo-js/auth'

export type WorkosJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkosJsonValue[]
  | { readonly [key: string]: WorkosJsonValue }

export interface WorkosIdentityProfile {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly emailVerified: boolean
  readonly firstName?: string
  readonly lastName?: string
  readonly profilePictureUrl?: string
  readonly externalId?: string
  readonly organizationId?: string
  readonly metadata: Readonly<Record<string, WorkosJsonValue>>
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly raw: Readonly<Record<string, WorkosJsonValue>>
}

export type WorkosUserAttributeValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly WorkosUserAttributeValue[]
  | { readonly [key: string]: WorkosUserAttributeValue }

export type WorkosUserAttributes = Readonly<Record<string, WorkosUserAttributeValue>>

export type WorkosDefaultUserAttributes = {
  readonly email: string
  readonly name: string
}

export type WorkosUserMapper<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> = (
  workosUser: WorkosIdentityProfile,
) => TUserAttributes

export type WorkosCompleteAuthOptions<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> = {
  readonly provider?: string
  readonly user?: WorkosUserMapper<TUserAttributes>
}

export type WorkosSyncIdentityOptions<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> = {
  readonly user?: WorkosUserMapper<TUserAttributes>
}

export interface WorkosVerifiedSession {
  readonly sessionId: string
  readonly identity: WorkosIdentityProfile
  readonly accessToken?: string
  readonly expiresAt?: Date
  readonly raw?: unknown
}

export interface WorkosLogoutSession {
  readonly provider: string
  readonly sessionId: string
}

export type WorkosAuthenticatedUser<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> =
  AuthenticatedAuthUser & Omit<TUserAttributes, 'can' | 'id'> & {
    readonly id: string | number
  }

export type WorkosHostedAuthFailureFields = AuthFieldErrors<'_root'>

export interface WorkosCompleteAuthData<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly status: WorkosSyncStatus
  readonly user: WorkosAuthenticatedUser<TUserAttributes>
  readonly identity: HostedIdentityRecord
  readonly session: WorkosVerifiedSession
  readonly authSession?: AuthEstablishedSession
}

export type WorkosCompleteAuthResult<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> =
  AuthResult<WorkosCompleteAuthData<TUserAttributes>, string, WorkosHostedAuthFailureFields>

export type WorkosLogoutErrorCode = 'workos_logout_failed' | 'workos_session_missing'

export interface WorkosLogoutData {
  readonly url: string
  readonly local: AuthLogoutResult
}

export type WorkosLogoutResult = AuthResult<WorkosLogoutData, WorkosLogoutErrorCode, WorkosHostedAuthFailureFields>

export interface WorkosVerifyRequestContext {
  readonly provider: string
  readonly request: Request
  readonly config: NormalizedAuthWorkosProviderConfig
}

export interface WorkosVerifySessionContext {
  readonly provider: string
  readonly token: string
  readonly config: NormalizedAuthWorkosProviderConfig
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

export type WorkosAuthenticationResult<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> =
  WorkosCompleteAuthData<TUserAttributes>

export interface WorkosAuthBindings {
  readonly providers: Readonly<Record<string, WorkosProviderRuntime>>
  readonly identityStore: HostedIdentityStore
}

export interface ConfigureWorkosAuthRuntimeOptions {
  readonly providers?: Readonly<Record<string, WorkosProviderRuntime>>
  readonly identityStore?: HostedIdentityStore
}

export interface WorkosAuthFacade {
  loginWithWorkos(request: Request, options?: { readonly provider?: string }): Promise<Response>
  registerWithWorkos(request: Request, options?: { readonly provider?: string }): Promise<Response>
  logoutWithWorkos(request: Request, options?: { readonly provider?: string, readonly returnTo?: string }): Promise<Response>
  completeWorkosAuth<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes>(
    request: Request,
    options?: WorkosCompleteAuthOptions<TUserAttributes>,
  ): Promise<WorkosCompleteAuthResult<TUserAttributes>>
  verifyRequest(request: Request, provider?: string): Promise<WorkosVerifiedSession | null>
  verifySession(token: string, provider?: string): Promise<WorkosVerifiedSession | null>
  syncIdentity<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes>(
    session: WorkosVerifiedSession,
    provider?: string,
    options?: WorkosSyncIdentityOptions<TUserAttributes>,
  ): Promise<WorkosAuthenticationResult<TUserAttributes>>
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
