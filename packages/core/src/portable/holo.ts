import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  config as globalConfig,
  configureConfigRuntime,
  createConfigAccessors,
  loadConfigDirectory,
  resetConfigRuntime,
  useConfig as globalUseConfig,
  type DotPath,
  type LoadedHoloConfig,
  type HoloConfigMap,
  type ValueAtPath,
} from '@holo-js/config'
import {
  configureDB,
  DB,
  resetDB,
} from '@holo-js/db'
import { resolveRuntimeConnectionManagerOptions } from './dbRuntime'
import { loadGeneratedProjectRegistry, type GeneratedProjectRegistry } from './registry'
import { importBundledRuntimeModule } from '../runtimeModule'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../storageRuntime'

type RuntimeConfigRegistry<TCustom extends HoloConfigMap> = LoadedHoloConfig<TCustom>['all']
type PortableRuntimeConfig<TCustom extends HoloConfigMap> = {
  readonly db: LoadedHoloConfig<TCustom>['database']
  readonly queue: LoadedHoloConfig<TCustom>['queue']
}

type CoreNotificationJsonPrimitive = string | number | boolean | null
type CoreNotificationJsonValue
  = CoreNotificationJsonPrimitive
  | readonly CoreNotificationJsonValue[]
  | { readonly [key: string]: CoreNotificationJsonValue }

interface CoreNotificationDatabaseRoute {
  readonly id: string | number
  readonly type: string
}

interface CoreNotificationRecord<TData extends CoreNotificationJsonValue = CoreNotificationJsonValue> {
  readonly id: string
  readonly type?: string
  readonly notifiableType: string
  readonly notifiableId: string | number
  readonly data: TData
  readonly readAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface CoreNotificationStore {
  create(record: CoreNotificationRecord): Promise<void>
  list(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]>
  unread(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]>
  markAsRead(ids: readonly string[]): Promise<number>
  markAsUnread(ids: readonly string[]): Promise<number>
  delete(ids: readonly string[]): Promise<number>
}

export interface HoloSessionRuntimeBinding {
  create(input?: { readonly store?: string, readonly data?: Readonly<Record<string, unknown>>, readonly id?: string }): Promise<unknown>
  write(record: unknown): Promise<unknown>
  read(sessionId: string, options?: { readonly store?: string }): Promise<unknown | null>
  rotate(sessionId: string, options?: { readonly store?: string, readonly newId?: string }): Promise<unknown>
  invalidate(sessionId: string, options?: { readonly store?: string }): Promise<void>
  touch(sessionId: string, options?: { readonly store?: string }): Promise<unknown | null>
  issueRememberMeToken(sessionId: string, options?: { readonly store?: string }): Promise<string>
  consumeRememberMeToken(token: string, options?: { readonly store?: string }): Promise<unknown | null>
  cookie(name: string, value: string, options?: Record<string, unknown>): string
  sessionCookie(value: string, options?: Record<string, unknown>): string
  rememberMeCookie(value: string, options?: Record<string, unknown>): string
}

export interface HoloAuthRuntimeBinding {
  check(): Promise<boolean>
  user(): Promise<unknown | null>
  refreshUser(): Promise<unknown | null>
  id(): Promise<string | number | null>
  currentAccessToken(): Promise<unknown | null>
  hashPassword(password: string): Promise<string>
  verifyPassword(password: string, digest: string): Promise<boolean>
  needsPasswordRehash(digest: string): Promise<boolean>
  login(credentials: Readonly<Record<string, unknown>> & {
    readonly password: string
    readonly remember?: boolean
  }): Promise<{
    readonly guard: string
    readonly user: unknown
    readonly sessionId: string
    readonly rememberToken?: string
    readonly cookies: readonly string[]
  }>
  loginUsing(
    user: unknown,
    options?: {
      readonly remember?: boolean
    },
  ): Promise<{
    readonly guard: string
    readonly user: unknown
    readonly sessionId: string
    readonly rememberToken?: string
    readonly cookies: readonly string[]
  }>
  loginUsingId(
    userId: string | number,
    options?: {
      readonly remember?: boolean
    },
  ): Promise<{
    readonly guard: string
    readonly user: unknown
    readonly sessionId: string
    readonly rememberToken?: string
    readonly cookies: readonly string[]
  }>
  impersonate(
    user: unknown,
    options?: {
      readonly remember?: boolean
      readonly actorGuard?: string
    },
  ): Promise<{
    readonly guard: string
    readonly user: unknown
    readonly sessionId: string
    readonly rememberToken?: string
    readonly cookies: readonly string[]
  }>
  impersonateById(
    userId: string | number,
    options?: {
      readonly remember?: boolean
      readonly actorGuard?: string
    },
  ): Promise<{
    readonly guard: string
    readonly user: unknown
    readonly sessionId: string
    readonly rememberToken?: string
    readonly cookies: readonly string[]
  }>
  impersonation(): Promise<unknown | null>
  stopImpersonating(): Promise<unknown | null>
  logout(): Promise<{
    readonly guard: string
    readonly cookies: readonly string[]
  }>
  register(input: Readonly<Record<string, unknown>> & {
    readonly password: string
    readonly passwordConfirmation: string
    readonly remember?: boolean
  }): Promise<unknown>
  logoutAll(guardName?: string): Promise<readonly {
    readonly guard: string
    readonly cookies: readonly string[]
  }[]>
  guard(name: string): {
    check(): Promise<boolean>
    user(): Promise<unknown | null>
    refreshUser(): Promise<unknown | null>
    id(): Promise<string | number | null>
    currentAccessToken(): Promise<unknown | null>
    login(credentials: Readonly<Record<string, unknown>> & {
      readonly password: string
      readonly remember?: boolean
    }): Promise<{
      readonly guard: string
      readonly user: unknown
      readonly sessionId: string
      readonly rememberToken?: string
      readonly cookies: readonly string[]
    }>
    loginUsing(
      user: unknown,
      options?: {
        readonly remember?: boolean
      },
    ): Promise<{
      readonly guard: string
      readonly user: unknown
      readonly sessionId: string
      readonly rememberToken?: string
      readonly cookies: readonly string[]
    }>
    loginUsingId(
      userId: string | number,
      options?: {
        readonly remember?: boolean
      },
    ): Promise<{
      readonly guard: string
      readonly user: unknown
      readonly sessionId: string
      readonly rememberToken?: string
      readonly cookies: readonly string[]
    }>
    impersonate(
      user: unknown,
      options?: {
        readonly remember?: boolean
        readonly actorGuard?: string
      },
    ): Promise<{
      readonly guard: string
      readonly user: unknown
      readonly sessionId: string
      readonly rememberToken?: string
      readonly cookies: readonly string[]
    }>
    impersonateById(
      userId: string | number,
      options?: {
        readonly remember?: boolean
        readonly actorGuard?: string
      },
    ): Promise<{
      readonly guard: string
      readonly user: unknown
      readonly sessionId: string
      readonly rememberToken?: string
      readonly cookies: readonly string[]
    }>
    impersonation(): Promise<unknown | null>
    stopImpersonating(): Promise<unknown | null>
    logout(): Promise<{
      readonly guard: string
      readonly cookies: readonly string[]
    }>
  }
  tokens: {
    create(user: unknown, options: {
      readonly name: string
      readonly abilities?: readonly string[]
      readonly expiresAt?: Date | null
      readonly guard?: string
    }): Promise<unknown>
    list(user: unknown, options?: { readonly guard?: string }): Promise<readonly unknown[]>
    revoke(options?: { readonly guard?: string }): Promise<void>
    revokeAll(user: unknown, options?: { readonly guard?: string }): Promise<number>
    authenticate(plainTextToken: string): Promise<unknown | null>
    can(token: string, ability: string): Promise<boolean>
  }
  verification: {
    create(user: unknown, options?: { readonly guard?: string, readonly expiresAt?: Date }): Promise<unknown>
    consume(plainTextToken: string): Promise<unknown>
  }
  passwords: {
    request(email: string, options?: { readonly broker?: string, readonly expiresAt?: Date }): Promise<void>
    consume(input: {
      readonly token: string
      readonly password: string
      readonly passwordConfirmation: string
    }): Promise<unknown>
  }
}

export interface HoloQueueRuntimeBinding {
  readonly config: LoadedHoloConfig['queue']
  readonly drivers: ReadonlyMap<string, HoloQueueDriverBinding>
}

export interface HoloQueueDriverBinding {
  readonly name: string
  readonly driver: string
  readonly mode: 'async' | 'sync'
}

export interface HoloServerViewRenderInput {
  readonly view: string
  readonly props?: Readonly<Record<string, unknown>>
}

export type HoloServerViewRenderer = (
  input: HoloServerViewRenderInput,
) => string | Promise<string>

type QueueModule = {
  configureQueueRuntime(options: { config: LoadedHoloConfig['queue'] } & Record<string, unknown>): void
  getRegisteredQueueJob(name: string): { sourcePath?: string } | undefined
  getQueueRuntime(): HoloQueueRuntimeBinding
  isQueueJobDefinition(value: unknown): boolean
  normalizeQueueJobDefinition(value: unknown): NormalizedQueueJobDefinition
  registerQueueJob(
    definition: NormalizedQueueJobDefinition,
    options: { name: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  shutdownQueueRuntime(): Promise<void>
  unregisterQueueJob(name: string): void
}

type QueueDbModule = {
  createQueueDbRuntimeOptions(): Record<string, unknown>
}

type EventsModule = {
  ensureEventsQueueJobRegisteredAsync?(): Promise<void>
  getRegisteredEvent(name: string): { sourcePath?: string } | undefined
  getRegisteredListener(id: string): { sourcePath?: string } | undefined
  isEventDefinition(value: unknown): boolean
  isListenerDefinition(value: unknown): boolean
  normalizeListenerDefinition(value: unknown): NormalizedListenerDefinition
  registerEvent(
    definition: unknown,
    options: { name: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  registerListener(
    definition: NormalizedListenerDefinition,
    options: { id: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  unregisterEvent(name: string): void
  unregisterListener(id: string): void
}

type SessionModule = {
  configureSessionRuntime(options?: {
    readonly config: LoadedHoloConfig['session']
    readonly stores: Readonly<Record<string, {
      read(sessionId: string): Promise<unknown | null>
      write(record: unknown): Promise<void>
      delete(sessionId: string): Promise<void>
    }>>
  }): void
  createDatabaseSessionStore(adapter: {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }): {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }
  createFileSessionStore(root: string): {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }
  createRedisSessionStore(adapter: SessionRedisAdapter): {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }
  getSessionRuntime(): HoloSessionRuntimeBinding
  resetSessionRuntime(): void
}

type SecurityModule = {
  configureSecurityRuntime(options?: {
    readonly config: LoadedHoloConfig['security']
    readonly rateLimitStore?: {
      hit(key: string, options: { readonly maxAttempts: number, readonly decaySeconds: number }): Promise<unknown>
      clear(key: string): Promise<boolean>
      clearByPrefix(prefix: string): Promise<number>
      clearAll(): Promise<number>
      close?(): Promise<void> | void
    }
    readonly csrfSigningKey?: string
    readonly defaultKeyResolver?: (request: Request) => Promise<string | number | null | undefined> | string | number | null | undefined
  }): void
  createRateLimitStoreFromConfig(
    config: LoadedHoloConfig['security'],
    options?: {
      readonly projectRoot?: string
      readonly redisAdapter?: unknown
    },
  ): {
    hit(key: string, options: { readonly maxAttempts: number, readonly decaySeconds: number }): Promise<unknown>
    clear(key: string): Promise<boolean>
    clearByPrefix(prefix: string): Promise<number>
    clearAll(): Promise<number>
    close?(): Promise<void> | void
  }
  getSecurityRuntimeBindings(): {
    readonly config?: LoadedHoloConfig['security']
    readonly rateLimitStore?: {
      hit(key: string, options: { readonly maxAttempts: number, readonly decaySeconds: number }): Promise<unknown>
      clear(key: string): Promise<boolean>
      clearByPrefix(prefix: string): Promise<number>
      clearAll(): Promise<number>
      close?(): Promise<void> | void
    }
    readonly csrfSigningKey?: string
    readonly defaultKeyResolver?: (request: Request) => Promise<string | number | null | undefined> | string | number | null | undefined
  } | undefined
  resetSecurityRuntime(): void
}

type SecurityRedisAdapter = {
  connect?(): Promise<void>
  increment(key: string, options: { readonly decaySeconds: number }): Promise<unknown>
  del(key: string): Promise<number>
  clearByPrefix?(prefix: string): Promise<number>
  clearAll?(): Promise<number>
  close?(): Promise<void>
}

type SecurityRedisAdapterModule = {
  createSecurityRedisAdapter(config: LoadedHoloConfig['security']['rateLimit']['redis']): SecurityRedisAdapter
}

type LoadedSessionRedisStoreConfig = Extract<LoadedHoloConfig['session']['stores'][string], {
  readonly driver: 'redis'
}>

type SessionRedisAdapter = {
  connect?(): Promise<void>
  disconnect?(): Promise<void>
  get(sessionId: string): Promise<unknown | null>
  set(record: unknown): Promise<void>
  del(sessionId: string): Promise<void>
  close?(): Promise<void>
}

type SessionRedisAdapterModule = {
  createSessionRedisAdapter(config: LoadedSessionRedisStoreConfig): SessionRedisAdapter
}

function closeSessionRedisAdapter(adapter: SessionRedisAdapter): Promise<void> | void {
  return adapter.disconnect?.() || adapter.close?.()
}

type NotificationsModule = {
  configureNotificationsRuntime(options?: {
    readonly config: LoadedHoloConfig['notifications']
    readonly mailer?: {
      send(message: {
        readonly subject: string
        readonly greeting?: string
        readonly lines?: readonly string[]
        readonly action?: {
          readonly label: string
          readonly url: string
        }
        readonly html?: string
        readonly text?: string
        readonly metadata?: Readonly<Record<string, unknown>>
      }, context: {
        readonly route?: string | { readonly email: string, readonly name?: string }
      }): Promise<void>
    }
    readonly store?: {
      create(record: unknown): Promise<void>
      list(notifiable: { id: string | number, type: string }): Promise<readonly unknown[]>
      unread(notifiable: { id: string | number, type: string }): Promise<readonly unknown[]>
      markAsRead(ids: readonly string[]): Promise<number>
      markAsUnread(ids: readonly string[]): Promise<number>
      delete(ids: readonly string[]): Promise<number>
    }
    readonly broadcaster?: ReturnType<typeof createCoreNotificationBroadcaster>
  }): void
  getNotificationsRuntimeBindings(): {
    readonly mailer?: {
      send(message: {
        readonly subject: string
      }, context: {
        readonly route?: string | { readonly email: string, readonly name?: string }
      }): Promise<void>
    }
    readonly broadcaster?: {
      send(message: unknown, context: {
        readonly channel: string
        readonly route?: unknown
      }): Promise<void>
    }
    readonly store?: {
      create(record: unknown): Promise<void>
      list(notifiable: { id: string | number, type: string }): Promise<readonly unknown[]>
      unread(notifiable: { id: string | number, type: string }): Promise<readonly unknown[]>
      markAsRead(ids: readonly string[]): Promise<number>
      markAsUnread(ids: readonly string[]): Promise<number>
      delete(ids: readonly string[]): Promise<number>
    }
  }
  defineNotification(definition: {
    readonly type?: string
    via(notifiable: unknown, context: { readonly anonymous: boolean }): readonly string[]
    readonly build: Readonly<Record<string, (notifiable: unknown, context: { readonly channel: string, readonly anonymous: boolean }) => unknown>>
  }): unknown
  notify(notifiable: unknown, notification: unknown): PromiseLike<unknown>
  notifyUsing(): {
    channel(channel: 'email', route: string | { readonly email: string, readonly name?: string }): {
      notify(notification: unknown): PromiseLike<unknown>
    }
  }
  resetNotificationsRuntime(): void
}

type BroadcastModule = {
  configureBroadcastRuntime(options?: {
    readonly config: LoadedHoloConfig['broadcast']
    readonly publish?: (
      input: {
        readonly connection: string
        readonly event: string
        readonly channels: readonly string[]
        readonly payload: Readonly<Record<string, unknown>>
        readonly socketId?: string
      },
      context: {
        readonly connection: string
        readonly driver: string
        readonly queued: boolean
        readonly delayed: boolean
      },
    ) => Promise<unknown> | unknown
  }): void
  getBroadcastRuntimeBindings(): {
    readonly config?: LoadedHoloConfig['broadcast']
    readonly publish?: (
      input: {
        readonly connection: string
        readonly event: string
        readonly channels: readonly string[]
        readonly payload: Readonly<Record<string, unknown>>
        readonly socketId?: string
      },
      context: {
        readonly connection: string
        readonly driver: string
        readonly queued: boolean
        readonly delayed: boolean
      },
    ) => Promise<unknown> | unknown
  }
  broadcastRaw(input: {
    readonly connection?: string
    readonly event: string
    readonly channels: readonly string[]
    readonly payload: Readonly<Record<string, unknown>>
    readonly socketId?: string
  }): PromiseLike<unknown>
  resetBroadcastRuntime(): void
}

const CORE_BROADCAST_PUBLISHER_MARKER = Symbol.for('holo-js.core.broadcast.publisher')

type MailModule = {
  configureMailRuntime(options?: {
    readonly config: LoadedHoloConfig['mail']
    readonly renderView?: HoloServerViewRenderer
  }): void
  getMailRuntimeBindings(): {
    readonly send?: unknown
    readonly preview?: unknown
    readonly renderPreview?: unknown
    readonly renderView?: HoloServerViewRenderer
  }
  sendMail(mail: {
    readonly mailer?: string
    readonly from?: unknown
    readonly replyTo?: unknown
    readonly to: unknown
    readonly cc?: unknown
    readonly bcc?: unknown
    readonly subject: string
    readonly text?: string
    readonly html?: string
    readonly markdown?: string
    readonly render?: {
      readonly view: string
      readonly props?: Readonly<Record<string, unknown>>
    }
    readonly markdownWrapper?: string
    readonly attachments?: readonly unknown[]
    readonly headers?: Readonly<Record<string, string>>
    readonly tags?: readonly string[]
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly priority?: 'high' | 'normal' | 'low'
    readonly queue?: boolean | {
      readonly queued?: boolean
      readonly connection?: string
      readonly queue?: string
      readonly afterCommit?: boolean
    }
    readonly delay?: number | Date
  }): PromiseLike<unknown>
  resetMailRuntime(): void
}

type AuthModule = {
  configureAuthRuntime(options?: {
    readonly config: LoadedHoloConfig['auth']
    readonly session: HoloSessionRuntimeBinding
    readonly providers: Readonly<Record<string, unknown>>
    readonly tokens?: {
      create(record: unknown): Promise<void>
      findById(id: string): Promise<unknown | null>
      listByUserId(provider: string, userId: string | number): Promise<readonly unknown[]>
      update(record: unknown): Promise<void>
      delete(id: string): Promise<void>
      deleteByUserId(provider: string, userId: string | number): Promise<number>
    }
    readonly emailVerificationTokens?: {
      create(record: unknown): Promise<void>
      findById(id: string): Promise<unknown | null>
      delete(id: string): Promise<void>
      deleteByUserId(provider: string, userId: string | number): Promise<number>
    }
    readonly passwordResetTokens?: {
      create(record: unknown): Promise<void>
      findById(id: string): Promise<unknown | null>
      delete(id: string, options?: { readonly table?: string }): Promise<void>
      deleteByEmail(provider: string, email: string, options?: { readonly table?: string }): Promise<number>
    }
    readonly delivery?: {
      sendEmailVerification(input: {
        readonly provider: string
        readonly user: unknown
        readonly email: string
        readonly token: unknown
      }): Promise<void>
      sendPasswordReset(input: {
        readonly provider: string
        readonly email: string
        readonly token: unknown
      }): Promise<void>
    }
    readonly context?: {
      activate?(): void
      getSessionId(guardName: string): string | undefined
      setSessionId(guardName: string, sessionId?: string): void
      getCachedUser(guardName: string): unknown
      setCachedUser(guardName: string, user: unknown): void
      getAccessToken?(guardName: string): string | undefined
      setAccessToken?(guardName: string, token?: string): void
      getRememberToken?(guardName: string): string | undefined
      setRememberToken?(guardName: string, token?: string): void
    }
  }): void
  createAsyncAuthContext(): {
    activate(): void
    getSessionId(guardName: string): string | undefined
    setSessionId(guardName: string, sessionId?: string): void
    getCachedUser(guardName: string): unknown
    setCachedUser(guardName: string, user: unknown): void
    getAccessToken?(guardName: string): string | undefined
    setAccessToken?(guardName: string, token?: string): void
    getRememberToken?(guardName: string): string | undefined
    setRememberToken?(guardName: string, token?: string): void
  }
  getAuthRuntime(): HoloAuthRuntimeBinding
  resetAuthRuntime(): void
}

type AuthorizationModule = {
  isAuthorizationPolicyDefinition(value: unknown): boolean
  isAuthorizationAbilityDefinition(value: unknown): boolean
  authorizationInternals: {
    getAuthorizationRuntimeState(): {
      policiesByName: Map<string, unknown>
      abilitiesByName: Map<string, unknown>
    }
    getAuthorizationAuthIntegration(): {
      hasGuard(guardName: string): boolean
      resolveDefaultActor(): Promise<object | null> | object | null
      resolveGuardActor(guardName: string): Promise<object | null> | object | null
    }
    registerPolicyDefinition?(definition: unknown): unknown
    registerAbilityDefinition?(definition: unknown): unknown
    configureAuthorizationAuthIntegration(options?: {
      hasGuard(guardName: string): boolean
      resolveDefaultActor(): Promise<object | null> | object | null
      resolveGuardActor(guardName: string): Promise<object | null> | object | null
    }): void
    resetAuthorizationAuthIntegration(): void
    resetAuthorizationRuntimeState(): void
    unregisterPolicyDefinition(name: string): void
    unregisterAbilityDefinition(name: string): void
  }
}

type SocialModule = {
  configureSocialAuthRuntime(options?: {
    readonly providers: Readonly<Record<string, unknown>>
    readonly stateStore: {
      create(record: {
        readonly provider: string
        readonly state: string
        readonly codeVerifier: string
        readonly guard: string
        readonly createdAt: Date
      }): Promise<void>
      read(provider: string, state: string): Promise<{
        readonly provider: string
        readonly state: string
        readonly codeVerifier: string
        readonly guard: string
        readonly createdAt: Date
      } | null>
      delete(provider: string, state: string): Promise<void>
    }
    readonly identityStore: {
      findByProviderUserId(provider: string, providerUserId: string): Promise<unknown | null>
      save(record: unknown): Promise<void>
    }
    readonly encryptionKey?: string
  }): void
  resetSocialAuthRuntime(): void
}

type HostedAuthVerifierRuntime = {
  verifyRequest?(context: { readonly provider: string, readonly request: Request, readonly config: Record<string, unknown> }): Promise<unknown | null>
  verifySession?(context: { readonly provider: string, readonly token: string, readonly config: Record<string, unknown> }): Promise<unknown | null>
}

type WorkosModule = {
  configureWorkosAuthRuntime(options?: {
    readonly providers?: Readonly<Record<string, HostedAuthVerifierRuntime>>
    readonly identityStore?: {
      findByProviderUserId(provider: string, providerUserId: string): Promise<unknown | null>
      findByUserId(provider: string, authProvider: string, userId: string | number): Promise<unknown | null>
      save(record: unknown): Promise<void>
    }
  }): void
  resetWorkosAuthRuntime(): void
}

type ClerkModule = {
  configureClerkAuthRuntime(options?: {
    readonly providers?: Readonly<Record<string, HostedAuthVerifierRuntime>>
    readonly identityStore?: {
      findByProviderUserId(provider: string, providerUserId: string): Promise<unknown | null>
      findByUserId(provider: string, authProvider: string, userId: string | number): Promise<unknown | null>
      save(record: unknown): Promise<void>
    }
  }): void
  resetClerkAuthRuntime(): void
}

type PortableConnectionManager = ReturnType<typeof resolveRuntimeConnectionManagerOptions>

type NormalizedQueueJobDefinition = {
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

type NormalizedListenerDefinition = {
  readonly name?: string
  readonly queue?: boolean
  readonly [key: string]: unknown
}

export interface CreateHoloOptions {
  readonly envName?: string
  readonly preferCache?: boolean
  readonly processEnv?: NodeJS.ProcessEnv
  readonly registerProjectQueueJobs?: boolean
  readonly renderView?: HoloServerViewRenderer
}

export interface HoloRuntime<TCustom extends HoloConfigMap = HoloConfigMap> {
  readonly projectRoot: string
  readonly loadedConfig: LoadedHoloConfig<TCustom>
  readonly registry?: GeneratedProjectRegistry
  readonly manager: PortableConnectionManager
  readonly runtimeConfig: PortableRuntimeConfig<TCustom>
  readonly queue: HoloQueueRuntimeBinding
  readonly session?: HoloSessionRuntimeBinding
  readonly auth?: HoloAuthRuntimeBinding
  readonly initialized: boolean
  initialize(): Promise<void>
  shutdown(): Promise<void>
  useConfig<TKey extends Extract<keyof RuntimeConfigRegistry<TCustom>, string>>(
    key: TKey,
  ): RuntimeConfigRegistry<TCustom>[TKey]
  useConfig<TPath extends DotPath<RuntimeConfigRegistry<TCustom>>>(
    path: TPath,
  ): ValueAtPath<RuntimeConfigRegistry<TCustom>, TPath>
  config<TPath extends DotPath<RuntimeConfigRegistry<TCustom>>>(
    path: TPath,
  ): ValueAtPath<RuntimeConfigRegistry<TCustom>, TPath>
}

type MutableHoloRuntime<TCustom extends HoloConfigMap> = {
  -readonly [TKey in keyof HoloRuntime<TCustom>]: HoloRuntime<TCustom>[TKey]
}

function getRuntimeState(): {
  current?: HoloRuntime
  pending?: Promise<HoloRuntime>
  pendingProjectRoot?: string
  renderView?: HoloServerViewRenderer
  securityRedisAdapter?: SecurityRedisAdapter
  securityRateLimitStoreManaged?: boolean
  sessionRedisAdapters?: readonly SessionRedisAdapter[]
} {
  const runtime = globalThis as typeof globalThis & {
    __holoRuntime__?: {
      current?: HoloRuntime
      pending?: Promise<HoloRuntime>
      pendingProjectRoot?: string
      renderView?: HoloServerViewRenderer
      securityRedisAdapter?: SecurityRedisAdapter
      securityRateLimitStoreManaged?: boolean
      sessionRedisAdapters?: readonly SessionRedisAdapter[]
    }
  }

  runtime.__holoRuntime__ ??= {}
  return runtime.__holoRuntime__
}

export function configureHoloRenderingRuntime(
  bindings?: {
    readonly renderView?: HoloServerViewRenderer
  },
): void {
  getRuntimeState().renderView = bindings?.renderView
}

export function resetHoloRenderingRuntime(): void {
  getRuntimeState().renderView = undefined
}

function restoreHoloRenderingRuntime(
  renderView: HoloServerViewRenderer | undefined,
): void {
  if (renderView) {
    configureHoloRenderingRuntime({
      renderView,
    })
    return
  }

  resetHoloRenderingRuntime()
}

type OptionalSubsystemRuntimeBindings = Readonly<{
  readonly mail?: ReturnType<MailModule['getMailRuntimeBindings']>
  readonly notifications?: ReturnType<NotificationsModule['getNotificationsRuntimeBindings']>
  readonly broadcast?: ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>
  readonly session?: Readonly<{
    readonly sessionRedisAdapters?: readonly SessionRedisAdapter[]
  }>
  readonly security?: Readonly<{
    readonly bindings?: ReturnType<SecurityModule['getSecurityRuntimeBindings']>
    readonly securityRedisAdapter?: SecurityRedisAdapter
    readonly securityRateLimitStoreManaged?: boolean
  }>
}>

function snapshotOptionalSubsystemRuntimeBindings(): OptionalSubsystemRuntimeBindings {
  const state = getRuntimeState()
  const runtime = globalThis as typeof globalThis & {
    __holoMailRuntime__?: {
      bindings?: ReturnType<MailModule['getMailRuntimeBindings']>
    }
    __holoNotificationsRuntime__?: {
      bindings?: ReturnType<NotificationsModule['getNotificationsRuntimeBindings']>
    }
    __holoBroadcastRuntime__?: {
      bindings?: ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>
    }
    __holoSecurityRuntime__?: {
      bindings?: ReturnType<SecurityModule['getSecurityRuntimeBindings']>
    }
  }

  return Object.freeze({
    ...(runtime.__holoMailRuntime__?.bindings ? { mail: runtime.__holoMailRuntime__.bindings } : {}),
    ...(runtime.__holoNotificationsRuntime__?.bindings ? { notifications: runtime.__holoNotificationsRuntime__.bindings } : {}),
    ...(runtime.__holoBroadcastRuntime__?.bindings ? { broadcast: runtime.__holoBroadcastRuntime__.bindings } : {}),
    ...(state.sessionRedisAdapters
      ? {
          session: Object.freeze({
            sessionRedisAdapters: state.sessionRedisAdapters,
          }),
        }
      : {}),
    ...(
      runtime.__holoSecurityRuntime__?.bindings
      || state.securityRedisAdapter
      || typeof state.securityRateLimitStoreManaged !== 'undefined'
        ? {
            security: Object.freeze({
              ...(runtime.__holoSecurityRuntime__?.bindings ? { bindings: runtime.__holoSecurityRuntime__.bindings } : {}),
              ...(state.securityRedisAdapter ? { securityRedisAdapter: state.securityRedisAdapter } : {}),
              ...(typeof state.securityRateLimitStoreManaged !== 'undefined'
                ? { securityRateLimitStoreManaged: state.securityRateLimitStoreManaged }
                : {}),
            }),
          }
        : {}
    ),
  })
}

function restoreOptionalSubsystemRuntimeBindings(
  bindings: OptionalSubsystemRuntimeBindings,
): void {
  const state = getRuntimeState()
  const runtime = globalThis as typeof globalThis & {
    __holoMailRuntime__?: {
      bindings?: ReturnType<MailModule['getMailRuntimeBindings']>
    }
    __holoNotificationsRuntime__?: {
      bindings?: ReturnType<NotificationsModule['getNotificationsRuntimeBindings']>
    }
    __holoBroadcastRuntime__?: {
      bindings?: ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>
    }
    __holoSecurityRuntime__?: {
      bindings?: ReturnType<SecurityModule['getSecurityRuntimeBindings']>
    }
  }

  if (bindings.mail || runtime.__holoMailRuntime__) {
    runtime.__holoMailRuntime__ ??= {}
    runtime.__holoMailRuntime__.bindings = bindings.mail
  }

  if (bindings.notifications || runtime.__holoNotificationsRuntime__) {
    runtime.__holoNotificationsRuntime__ ??= {}
    runtime.__holoNotificationsRuntime__.bindings = bindings.notifications
  }

  if (bindings.broadcast || runtime.__holoBroadcastRuntime__) {
    runtime.__holoBroadcastRuntime__ ??= {}
    runtime.__holoBroadcastRuntime__.bindings = bindings.broadcast
  }

  state.sessionRedisAdapters = bindings.session?.sessionRedisAdapters

  if (bindings.security || runtime.__holoSecurityRuntime__) {
    runtime.__holoSecurityRuntime__ ??= {}
    runtime.__holoSecurityRuntime__.bindings = bindings.security?.bindings
    state.securityRedisAdapter = bindings.security?.securityRedisAdapter
    state.securityRateLimitStoreManaged = bindings.security?.securityRateLimitStoreManaged
  }
}

const BROADCAST_PUBLISH_TIMEOUT_MS = 10_000

const portableRuntimeRequire = createRequire(import.meta.url)

function resolveOptionalImportSpecifier(specifier: string, projectRoot?: string): string {
  if (!projectRoot) {
    return specifier
  }

  try {
    const resolved = portableRuntimeRequire.resolve(specifier, {
      paths: [projectRoot],
    })
    return pathToFileURL(resolved).href
  } catch {
    return specifier
  }
}

async function importOptionalModule<TModule>(
  specifier: string,
  options: {
    readonly projectRoot?: string
  } = {},
): Promise<TModule | undefined> {
  const resolvedSpecifier = resolveOptionalImportSpecifier(specifier, options.projectRoot)

  try {
    return await import(/* webpackIgnore: true */ resolvedSpecifier as string) as TModule
  } catch (error) {
    /* v8 ignore start -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
    if (
      error instanceof Error
      && (
        error.message.includes(`Cannot find package '${specifier}'`)
        || error.message.includes(`Cannot find module '${specifier}'`)
        || error.message.includes(`Failed to load url ${specifier}`)
        || error.message.includes(`Could not resolve "${specifier}"`)
        || error.message.includes(`Cannot find package '${resolvedSpecifier}'`)
        || error.message.includes(`Cannot find module '${resolvedSpecifier}'`)
        || error.message.includes(`Failed to load url ${resolvedSpecifier}`)
        || error.message.includes(`Could not resolve "${resolvedSpecifier}"`)
      )
    ) {
      return undefined
    }
    /* v8 ignore stop */

    throw error
  }
}

const portableRuntimeModuleInternals = {
  importOptionalModule,
}

function hasLoadedConfigFile<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
  configName: string,
): boolean {
  return loadedConfig.loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
}

function queueConfigUsesDatabaseDriver<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return Object.values(loadedConfig.queue.connections).some(connection => connection.driver === 'database')
}

function queueConfigUsesDatabaseBackedFailedStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return loadedConfig.queue.failed !== false
}

function registryHasJobs(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.jobs.length ?? 0) > 0
}

function registryHasEvents(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.events.length ?? 0) > 0 || (registry?.listeners.length ?? 0) > 0
}

function authConfigUsesSocialProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return Object.keys(loadedConfig.auth.social).length > 0
}

function authConfigUsesWorkosProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return Object.keys(loadedConfig.auth.workos).length > 0
}

function authConfigUsesClerkProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return Object.keys(loadedConfig.auth.clerk).length > 0
}

const HOLO_AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function bindAuthRuntimeToContext(
  runtime: HoloAuthRuntimeBinding,
  authContext: { activate(): void },
): HoloAuthRuntimeBinding {
  type GuardRuntime = ReturnType<HoloAuthRuntimeBinding['guard']>

  const activate = (): void => {
    authContext.activate()
  }

  return Object.freeze({
    check() {
      activate()
      return runtime.check()
    },
    user() {
      activate()
      return runtime.user()
    },
    refreshUser() {
      activate()
      return runtime.refreshUser()
    },
    id() {
      activate()
      return runtime.id()
    },
    currentAccessToken() {
      activate()
      return runtime.currentAccessToken()
    },
    hashPassword(password: Parameters<HoloAuthRuntimeBinding['hashPassword']>[0]) {
      activate()
      return runtime.hashPassword(password)
    },
    verifyPassword(
      password: Parameters<HoloAuthRuntimeBinding['verifyPassword']>[0],
      digest: Parameters<HoloAuthRuntimeBinding['verifyPassword']>[1],
    ) {
      activate()
      return runtime.verifyPassword(password, digest)
    },
    needsPasswordRehash(digest: Parameters<HoloAuthRuntimeBinding['needsPasswordRehash']>[0]) {
      activate()
      return runtime.needsPasswordRehash(digest)
    },
    login(credentials: Parameters<HoloAuthRuntimeBinding['login']>[0]) {
      activate()
      return runtime.login(credentials)
    },
    loginUsing(
      user: Parameters<HoloAuthRuntimeBinding['loginUsing']>[0],
      options?: Parameters<HoloAuthRuntimeBinding['loginUsing']>[1],
    ) {
      activate()
      return runtime.loginUsing(user, options)
    },
    loginUsingId(
      userId: Parameters<HoloAuthRuntimeBinding['loginUsingId']>[0],
      options?: Parameters<HoloAuthRuntimeBinding['loginUsingId']>[1],
    ) {
      activate()
      return runtime.loginUsingId(userId, options)
    },
    impersonate(
      user: Parameters<HoloAuthRuntimeBinding['impersonate']>[0],
      options?: Parameters<HoloAuthRuntimeBinding['impersonate']>[1],
    ) {
      activate()
      return runtime.impersonate(user, options)
    },
    impersonateById(
      userId: Parameters<HoloAuthRuntimeBinding['impersonateById']>[0],
      options?: Parameters<HoloAuthRuntimeBinding['impersonateById']>[1],
    ) {
      activate()
      return runtime.impersonateById(userId, options)
    },
    impersonation() {
      activate()
      return runtime.impersonation()
    },
    stopImpersonating() {
      activate()
      return runtime.stopImpersonating()
    },
    logout() {
      activate()
      return runtime.logout()
    },
    register(input: Parameters<HoloAuthRuntimeBinding['register']>[0]) {
      activate()
      return runtime.register(input)
    },
    logoutAll(guardName?: Parameters<HoloAuthRuntimeBinding['logoutAll']>[0]) {
      activate()
      return runtime.logoutAll(guardName)
    },
    guard(name: Parameters<HoloAuthRuntimeBinding['guard']>[0]) {
      const guard = runtime.guard(name)

      return Object.freeze({
        check() {
          activate()
          return guard.check()
        },
        user() {
          activate()
          return guard.user()
        },
        refreshUser() {
          activate()
          return guard.refreshUser()
        },
        id() {
          activate()
          return guard.id()
        },
        currentAccessToken() {
          activate()
          return guard.currentAccessToken()
        },
        login(credentials: Parameters<GuardRuntime['login']>[0]) {
          activate()
          return guard.login(credentials)
        },
        loginUsing(
          user: Parameters<GuardRuntime['loginUsing']>[0],
          options?: Parameters<GuardRuntime['loginUsing']>[1],
        ) {
          activate()
          return guard.loginUsing(user, options)
        },
        loginUsingId(
          userId: Parameters<GuardRuntime['loginUsingId']>[0],
          options?: Parameters<GuardRuntime['loginUsingId']>[1],
        ) {
          activate()
          return guard.loginUsingId(userId, options)
        },
        impersonate(
          user: Parameters<GuardRuntime['impersonate']>[0],
          options?: Parameters<GuardRuntime['impersonate']>[1],
        ) {
          activate()
          return guard.impersonate(user, options)
        },
        impersonateById(
          userId: Parameters<GuardRuntime['impersonateById']>[0],
          options?: Parameters<GuardRuntime['impersonateById']>[1],
        ) {
          activate()
          return guard.impersonateById(userId, options)
        },
        impersonation() {
          activate()
          return guard.impersonation()
        },
        stopImpersonating() {
          activate()
          return guard.stopImpersonating()
        },
        logout() {
          activate()
          return guard.logout()
        },
      })
    },
    tokens: Object.freeze({
      create(
        user: Parameters<HoloAuthRuntimeBinding['tokens']['create']>[0],
        options: Parameters<HoloAuthRuntimeBinding['tokens']['create']>[1],
      ) {
        activate()
        return runtime.tokens.create(user, options)
      },
      list(
        user: Parameters<HoloAuthRuntimeBinding['tokens']['list']>[0],
        options?: Parameters<HoloAuthRuntimeBinding['tokens']['list']>[1],
      ) {
        activate()
        return runtime.tokens.list(user, options)
      },
      revoke(options?: Parameters<HoloAuthRuntimeBinding['tokens']['revoke']>[0]) {
        activate()
        return runtime.tokens.revoke(options)
      },
      revokeAll(
        user: Parameters<HoloAuthRuntimeBinding['tokens']['revokeAll']>[0],
        options?: Parameters<HoloAuthRuntimeBinding['tokens']['revokeAll']>[1],
      ) {
        activate()
        return runtime.tokens.revokeAll(user, options)
      },
      authenticate(plainTextToken: Parameters<HoloAuthRuntimeBinding['tokens']['authenticate']>[0]) {
        activate()
        return runtime.tokens.authenticate(plainTextToken)
      },
      can(
        token: Parameters<HoloAuthRuntimeBinding['tokens']['can']>[0],
        ability: Parameters<HoloAuthRuntimeBinding['tokens']['can']>[1],
      ) {
        activate()
        return runtime.tokens.can(token, ability)
      },
    }),
    verification: Object.freeze({
      create(
        user: Parameters<HoloAuthRuntimeBinding['verification']['create']>[0],
        options?: Parameters<HoloAuthRuntimeBinding['verification']['create']>[1],
      ) {
        activate()
        return runtime.verification.create(user, options)
      },
      consume(plainTextToken: Parameters<HoloAuthRuntimeBinding['verification']['consume']>[0]) {
        activate()
        return runtime.verification.consume(plainTextToken)
      },
    }),
    passwords: Object.freeze({
      request(
        email: Parameters<HoloAuthRuntimeBinding['passwords']['request']>[0],
        options?: Parameters<HoloAuthRuntimeBinding['passwords']['request']>[1],
      ) {
        activate()
        return runtime.passwords.request(email, options)
      },
      consume(input: Parameters<HoloAuthRuntimeBinding['passwords']['consume']>[0]) {
        activate()
        return runtime.passwords.consume(input)
      },
    }),
  })
}

async function loadQueueModule(required = false): Promise<QueueModule | undefined> {
  const queueModule = await portableRuntimeModuleInternals.importOptionalModule<QueueModule>('@holo-js/queue')
  /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!queueModule && required) {
    throw new Error('[@holo-js/core] Queue support requires @holo-js/queue to be installed.')
  }

  return queueModule
}

async function loadQueueDbModule(): Promise<QueueDbModule | undefined> {
  return portableRuntimeModuleInternals.importOptionalModule<QueueDbModule>('@holo-js/queue-db')
}

async function loadEventsModule(required = false): Promise<EventsModule | undefined> {
  const eventsModule = await portableRuntimeModuleInternals.importOptionalModule<EventsModule>('@holo-js/events')
  /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!eventsModule && required) {
    throw new Error('[@holo-js/core] Events support requires @holo-js/events to be installed.')
  }

  return eventsModule
}

async function loadSessionModule(required = false): Promise<SessionModule | undefined> {
  const sessionModule = await portableRuntimeModuleInternals.importOptionalModule<SessionModule>('@holo-js/session')
  if (!sessionModule && required) {
    throw new Error('[@holo-js/core] Session support requires @holo-js/session to be installed.')
  }

  return sessionModule
}

async function loadSecurityModule(required = false): Promise<SecurityModule | undefined> {
  const securityModule = await portableRuntimeModuleInternals.importOptionalModule<SecurityModule>('@holo-js/security')
  if (!securityModule && required) {
    throw new Error('[@holo-js/core] Security support requires @holo-js/security to be installed.')
  }

  return securityModule
}

async function loadSecurityRedisAdapterModule(required: true): Promise<SecurityRedisAdapterModule>
async function loadSecurityRedisAdapterModule(required?: false): Promise<SecurityRedisAdapterModule | undefined>
async function loadSecurityRedisAdapterModule(required = false): Promise<SecurityRedisAdapterModule | undefined> {
  const securityRedisAdapterModule = await portableRuntimeModuleInternals.importOptionalModule<SecurityRedisAdapterModule>('@holo-js/security/drivers/redis-adapter')
  if (!securityRedisAdapterModule && required) {
    throw new Error('[@holo-js/core] Redis-backed security rate limits require @holo-js/security/drivers/redis-adapter to be installed.')
  }

  return securityRedisAdapterModule
}

async function loadSessionRedisAdapterModule(required: true): Promise<SessionRedisAdapterModule>
async function loadSessionRedisAdapterModule(required?: false): Promise<SessionRedisAdapterModule | undefined>
async function loadSessionRedisAdapterModule(required = false): Promise<SessionRedisAdapterModule | undefined> {
  const sessionRedisAdapterModule = await portableRuntimeModuleInternals.importOptionalModule<SessionRedisAdapterModule>('@holo-js/session/drivers/redis-adapter')
  if (!sessionRedisAdapterModule && required) {
    throw new Error('[@holo-js/core] Redis-backed session stores require @holo-js/session/drivers/redis-adapter to be installed.')
  }

  return sessionRedisAdapterModule
}

async function loadNotificationsModule(required = false): Promise<NotificationsModule | undefined> {
  const notificationsModule = await portableRuntimeModuleInternals.importOptionalModule<NotificationsModule>('@holo-js/notifications')
  if (!notificationsModule && required) {
    throw new Error('[@holo-js/core] Notifications support requires @holo-js/notifications to be installed.')
  }

  return notificationsModule
}

async function loadBroadcastModule(required = false, projectRoot?: string): Promise<BroadcastModule | undefined> {
  const broadcastModule = await portableRuntimeModuleInternals.importOptionalModule<BroadcastModule>('@holo-js/broadcast', {
    projectRoot,
  })
  if (!broadcastModule && required) {
    throw new Error('[@holo-js/core] Broadcast support requires @holo-js/broadcast to be installed.')
  }

  return broadcastModule
}

async function loadMailModule(required = false): Promise<MailModule | undefined> {
  const mailModule = await portableRuntimeModuleInternals.importOptionalModule<MailModule>('@holo-js/mail')
  if (!mailModule && required) {
    throw new Error('[@holo-js/core] Mail support requires @holo-js/mail to be installed.')
  }

  return mailModule
}

async function loadAuthModule(required = false): Promise<AuthModule | undefined> {
  const authModule = await portableRuntimeModuleInternals.importOptionalModule<AuthModule>('@holo-js/auth')
  if (!authModule && required) {
    throw new Error('[@holo-js/core] Auth support requires @holo-js/auth to be installed.')
  }

  return authModule
}

async function loadAuthorizationModule(required = false): Promise<AuthorizationModule | undefined> {
  const authorizationModule = await portableRuntimeModuleInternals.importOptionalModule<AuthorizationModule>('@holo-js/authorization')
  if (!authorizationModule && required) {
    throw new Error('[@holo-js/core] Authorization support requires @holo-js/authorization to be installed.')
  }

  return authorizationModule
}

async function loadSocialModule(required = false): Promise<SocialModule | undefined> {
  const socialModule = await portableRuntimeModuleInternals.importOptionalModule<SocialModule>('@holo-js/auth-social')
  if (!socialModule && required) {
    throw new Error('[@holo-js/core] Social auth config requires @holo-js/auth-social to be installed.')
  }

  return socialModule
}

async function loadWorkosModule(required = false): Promise<WorkosModule | undefined> {
  const workosModule = await portableRuntimeModuleInternals.importOptionalModule<WorkosModule>('@holo-js/auth-workos')
  if (!workosModule && required) {
    throw new Error('[@holo-js/core] WorkOS auth config requires @holo-js/auth-workos to be installed.')
  }

  return workosModule
}

async function loadClerkModule(required = false): Promise<ClerkModule | undefined> {
  const clerkModule = await portableRuntimeModuleInternals.importOptionalModule<ClerkModule>('@holo-js/auth-clerk')
  if (!clerkModule && required) {
    throw new Error('[@holo-js/core] Clerk auth config requires @holo-js/auth-clerk to be installed.')
  }

  return clerkModule
}

function resolveQueueJobExport(
  queueModule: QueueModule,
  moduleValue: unknown,
): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (queueModule.isQueueJobDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => queueModule.isQueueJobDefinition(value))
}

function resolveAuthorizationDefinitionExport(
  moduleValue: unknown,
  exportName: string | undefined,
  matcher: (value: unknown) => boolean,
): unknown | undefined {
  const exports = moduleValue as Record<string, unknown>
  if (exportName && exportName !== 'default' && matcher(exports[exportName])) {
    return exports[exportName]
  }

  if (matcher(exports.default)) {
    return exports.default
  }

  return Object.entries(exports).find(([name, value]) => name !== exportName && matcher(value))?.[1]
}

const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

function hasEventDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

function resolveEventExport(moduleValue: unknown): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (hasEventDefinitionMarker(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasEventDefinitionMarker(value))
}

function resolveListenerExport(
  eventsModule: EventsModule,
  moduleValue: unknown,
): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (hasListenerDefinitionMarker(exports.default) || eventsModule.isListenerDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasListenerDefinitionMarker(value) || eventsModule.isListenerDefinition(value))
}

function resolveProjectRelativePath(projectRoot: string, value: string): string {
  return value.startsWith('.') || !value.startsWith('/')
    ? resolve(projectRoot, value)
    : value
}

function normalizeDateLike(value: unknown): Date {
  /* v8 ignore next -- helper accepts Date or date-like input; runtime paths mostly exercise serialized values */
  return value instanceof Date ? value : new Date(String(value))
}

function normalizeSessionRecordFromRow(row: Record<string, unknown>): {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
} {
  /* v8 ignore start -- defensive decoding for driver-specific session row shapes */
  const decodedData = (() => {
    if (row.data && typeof row.data === 'object') {
      return row.data as Record<string, unknown>
    }

    if (typeof row.data === 'string') {
      try {
        const parsed = JSON.parse(row.data) as unknown
        return parsed && typeof parsed === 'object'
          ? parsed as Record<string, unknown>
          : {}
      } catch {
        return {}
      }
    }

    return {}
  })()
  /* v8 ignore stop */

  return Object.freeze({
    id: String(row.id),
    /* v8 ignore next -- runtime rows usually carry an explicit store name; this preserves a safe default */
    store: typeof row.store === 'string' ? row.store : 'database',
    data: Object.freeze(decodedData),
    createdAt: normalizeDateLike(row.created_at),
    lastActivityAt: normalizeDateLike(row.last_activity_at),
    expiresAt: normalizeDateLike(row.expires_at),
    rememberTokenHash: typeof row.remember_token_hash === 'string' ? row.remember_token_hash : undefined,
  })
}

function serializeSessionRecordForRow(record: {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}): Record<string, unknown> {
  return {
    id: record.id,
    store: record.store,
    /* v8 ignore next -- record.data is always present in runtime flows; nullish fallback is purely defensive */
    data: JSON.stringify(record.data ?? {}),
    created_at: record.createdAt.toISOString(),
    last_activity_at: record.lastActivityAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    invalidated_at: null,
    remember_token_hash: record.rememberTokenHash ?? null,
  }
}

function normalizeNotificationRecordFromRow(row: Record<string, unknown>): CoreNotificationRecord<CoreNotificationJsonValue> {
  const decodedData = normalizeJsonValue(row.data)

  return Object.freeze({
    id: String(row.id),
    type: typeof row.type === 'string' ? row.type : undefined,
    notifiableType: String(row.notifiable_type),
    notifiableId: typeof row.notifiable_id === 'number' ? row.notifiable_id : String(row.notifiable_id),
    data: decodedData as CoreNotificationJsonValue,
    readAt: row.read_at ? normalizeDateLike(row.read_at) : null,
    createdAt: normalizeDateLike(row.created_at),
    updatedAt: normalizeDateLike(row.updated_at),
  })
}

function serializeNotificationRecordForRow(record: {
  readonly id: string
  readonly type?: string
  readonly notifiableType: string
  readonly notifiableId: string | number
  readonly data: unknown
  readonly readAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type ?? null,
    notifiable_type: record.notifiableType,
    notifiable_id: String(record.notifiableId),
    data: JSON.stringify(record.data ?? null),
    read_at: record.readAt ? record.readAt.toISOString() : null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  }
}

function getEntityAttributes(value: unknown): Record<string, unknown> {
  /* v8 ignore start -- defensive fallback handling for arbitrary model/entity serializers */
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
/* v8 ignore stop */

function markProviderUser<T>(value: T, providerName: string): T {
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
    // Non-extensible user objects can still fall back to id-based resolution.
  }

  return value
}

/* v8 ignore next -- helper body is covered through runtime initialization; this declaration line itself is a coverage artifact */
async function createCoreManagedSessionStores<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  sessionModule: SessionModule,
): Promise<{
  readonly stores: Readonly<Record<string, {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }>>
  readonly redisAdapters: readonly SessionRedisAdapter[]
}> {
  const stores: Record<string, {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }> = {}
  const redisAdapters: SessionRedisAdapter[] = []

  for (const [name, config] of Object.entries(loadedConfig.session.stores)) {
    if (config.driver === 'file') {
      stores[name] = sessionModule.createFileSessionStore(resolveProjectRelativePath(projectRoot, config.path))
      continue
    }

    if (config.driver === 'database') {
      const connectionName = config.connection === 'default' && !(config.connection in loadedConfig.database.connections)
        ? loadedConfig.database.defaultConnection
        : config.connection
      stores[name] = sessionModule.createDatabaseSessionStore({
        async read(sessionId) {
          const row = await DB.table(config.table, connectionName)
            .where('id', sessionId)
            .whereNull('invalidated_at')
            .first<Record<string, unknown>>()
          return row ? normalizeSessionRecordFromRow(row) : null
        },
        async write(record) {
          const normalized = serializeSessionRecordForRow(record as {
            readonly id: string
            readonly store: string
            readonly data: Readonly<Record<string, unknown>>
            readonly createdAt: Date
            readonly lastActivityAt: Date
            readonly expiresAt: Date
            readonly rememberTokenHash?: string
          })
          const existing = await DB.table(config.table, connectionName).find(String(normalized.id))
          if (existing) {
            await DB.table(config.table, connectionName)
              .where('id', normalized.id)
              .update(normalized)
            return
          }

          await DB.table(config.table, connectionName).insert(normalized)
        },
        async delete(sessionId) {
          await DB.table(config.table, connectionName)
            .where('id', sessionId)
            .delete()
        },
      })
      continue
    }

    if (config.driver === 'redis') {
      const sessionRedisAdapterModule = await loadSessionRedisAdapterModule(true)
      const adapter = sessionRedisAdapterModule.createSessionRedisAdapter(config)

      try {
        await adapter.connect?.()
        redisAdapters.push(adapter)
        const store = sessionModule.createRedisSessionStore(adapter)
        stores[name] = store
      } catch (error) {
        const originalError = error
        const cleanupResults = await Promise.allSettled([
          closeSessionRedisAdapter(adapter),
          ...redisAdapters
            .filter(existingAdapter => existingAdapter !== adapter)
            .map(existingAdapter => closeSessionRedisAdapter(existingAdapter)),
        ])
        const cleanupErrors = cleanupResults.flatMap(result => result.status === 'rejected' ? [result.reason] : [])

        if (cleanupErrors.length > 0 && originalError instanceof Error) {
          Object.defineProperty(originalError, 'cleanupErrors', {
            value: Object.freeze(cleanupErrors),
            configurable: true,
            enumerable: false,
          })
        }

        throw originalError
      }

      continue
    }
  }

  if (!(loadedConfig.session.driver in stores)) {
    throw new Error(
      `[@holo-js/core] Session driver "${loadedConfig.session.driver}" is configured but the runtime cannot boot it automatically.`,
    )
  }

  return Object.freeze({
    stores: Object.freeze(stores),
    redisAdapters: Object.freeze(redisAdapters),
  })
}

/* v8 ignore next -- helper body is covered through runtime initialization; this declaration line itself is a coverage artifact */
async function createCoreSessionStores<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  sessionModule: SessionModule,
): Promise<Readonly<Record<string, {
  read(sessionId: string): Promise<unknown | null>
  write(record: unknown): Promise<void>
  delete(sessionId: string): Promise<void>
}>>> {
  return (await createCoreManagedSessionStores(projectRoot, loadedConfig, sessionModule)).stores
}

function createCoreNotificationStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): CoreNotificationStore {
  const tableName = loadedConfig.notifications.table
  const connectionName = loadedConfig.database.defaultConnection

  const store: CoreNotificationStore = {
    async create(record: CoreNotificationRecord): Promise<void> {
      await DB.table(tableName, connectionName).insert(serializeNotificationRecordForRow(record))
    },
    async list(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]> {
      const rows = await DB.table(tableName, connectionName)
        .where('notifiable_type', notifiable.type)
        .where('notifiable_id', String(notifiable.id))
        .orderBy('created_at', 'desc')
        .get<Record<string, unknown>>()

      return Object.freeze(rows.map(row => normalizeNotificationRecordFromRow(row)))
    },
    async unread(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]> {
      const rows = await DB.table(tableName, connectionName)
        .where('notifiable_type', notifiable.type)
        .where('notifiable_id', String(notifiable.id))
        .whereNull('read_at')
        .orderBy('created_at', 'desc')
        .get<Record<string, unknown>>()

      return Object.freeze(rows.map(row => normalizeNotificationRecordFromRow(row)))
    },
    async markAsRead(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) {
        return 0
      }

      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .update({
          read_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

      return result.affectedRows ?? 0
    },
    async markAsUnread(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) {
        return 0
      }

      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .update({
          read_at: null,
          updated_at: new Date().toISOString(),
        })

      return result.affectedRows ?? 0
    },
    async delete(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) {
        return 0
      }

      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .delete()

      return result.affectedRows ?? 0
    },
  }

  return Object.freeze(store)
}

function createAuthNotificationsDeliveryHook(
  notificationsModule: NotificationsModule,
): {
  sendEmailVerification(input: {
    readonly provider: string
    readonly user: unknown
    readonly email: string
    readonly token: {
      readonly id: string
      readonly plainTextToken: string
      readonly expiresAt: Date
    }
  }): Promise<void>
  sendPasswordReset(input: {
    readonly provider: string
    readonly email: string
    readonly token: {
      readonly id: string
      readonly plainTextToken: string
      readonly expiresAt: Date
    }
  }): Promise<void>
} {
  return Object.freeze({
    async sendEmailVerification(input): Promise<void> {
      const recipientName = typeof (input.user as { name?: unknown })?.name === 'string'
        ? (input.user as { name?: string }).name?.trim()
        : undefined
      const notification = notificationsModule.defineNotification({
        type: 'auth.email-verification',
        via() {
          return ['email'] as const
        },
        build: {
          email() {
            return {
              subject: 'Verify your email address',
              ...(recipientName ? { greeting: `Hello ${recipientName},` } : {}),
              lines: [
                'Use this token to verify your email address:',
                input.token.plainTextToken,
                `Provider: ${input.provider}`,
                `Expires at: ${input.token.expiresAt.toISOString()}`,
              ],
              metadata: {
                provider: input.provider,
                tokenId: input.token.id,
              },
            }
          },
        },
      })

      await notificationsModule
        .notifyUsing()
        .channel('email', recipientName
          ? {
              email: input.email,
              name: recipientName,
            }
          : input.email)
        .notify(notification)
    },
    async sendPasswordReset(input): Promise<void> {
      const notification = notificationsModule.defineNotification({
        type: 'auth.password-reset',
        via() {
          return ['email'] as const
        },
        build: {
          email() {
            return {
              subject: 'Reset your password',
              lines: [
                'Use this token to reset your password:',
                input.token.plainTextToken,
                `Provider: ${input.provider}`,
                `Expires at: ${input.token.expiresAt.toISOString()}`,
              ],
              metadata: {
                provider: input.provider,
                tokenId: input.token.id,
              },
            }
          },
        },
      })

      await notificationsModule
        .notifyUsing()
        .channel('email', input.email)
        .notify(notification)
    },
  })
}

function createCoreNotificationBroadcaster(
  broadcastModule: BroadcastModule,
): {
  send(
    message: {
      readonly event?: string
      readonly data: unknown
    },
    context: {
      readonly route?: unknown
      readonly notificationType?: string
    },
  ): Promise<void>
} {
  const normalizeChannels = (route: unknown): readonly string[] => {
    if (typeof route === 'string') {
      const value = route.trim()
      if (value) {
        return Object.freeze([value])
      }
    }

    if (Array.isArray(route)) {
      const channels = route
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(Boolean)
      if (channels.length > 0) {
        return Object.freeze(channels)
      }
    }

    if (
      route
      && typeof route === 'object'
      && 'channels' in route
      && Array.isArray((route as { channels?: unknown }).channels)
    ) {
      const channels = ((route as { channels: unknown[] }).channels)
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(Boolean)
      if (channels.length > 0) {
        return Object.freeze(channels)
      }
    }

    throw new Error('[@holo-js/core] Broadcast notifications require at least one resolved channel route.')
  }

  return Object.freeze({
    async send(message, context): Promise<void> {
      const channels = normalizeChannels(context.route)
      const event = typeof message.event === 'string' && message.event.trim()
        ? message.event.trim()
        : 'notifications.message'

      await broadcastModule.broadcastRaw({
        event,
        channels,
        payload: Object.freeze({
          ...(typeof context.notificationType === 'string' && context.notificationType.trim()
            ? { type: context.notificationType.trim() }
            : {}),
          data: message.data ?? null,
        }),
      })
    },
  })
}

function createCoreBroadcastPublisher(
  loadedConfig: LoadedHoloConfig['broadcast'],
): NonNullable<ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>['publish']> {
  const connectionHosts = new Set(['holo', 'pusher'])

  const publish: NonNullable<ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>['publish']> = async (input, context) => {
    const connection = loadedConfig.connections[input.connection]
    /* v8 ignore next 3 -- defensive guard; broadcast runtime resolves connections before publish */
    if (!connection) {
      throw new Error(`[@holo-js/core] Broadcast connection "${input.connection}" is not configured.`)
    }

    /* v8 ignore next 3 -- defensive guard; broadcast config normalization ensures these fields exist */
    if (!('appId' in connection) || !('key' in connection) || !('secret' in connection)) {
      throw new Error(`[@holo-js/core] Broadcast connection "${input.connection}" cannot be published automatically.`)
    }

    /* v8 ignore next 3 -- defensive guard; only holo/pusher drivers reach this path */
    if (!connectionHosts.has(connection.driver)) {
      throw new Error(`[@holo-js/core] Broadcast connection "${input.connection}" cannot be published automatically.`)
    }

    const options = connection.options
    /* v8 ignore next -- tests only exercise http scheme */
    const protocol = options.scheme === 'http' ? 'http:' : 'https:'
    const url = new URL(`/apps/${encodeURIComponent(connection.appId)}/events`, `${protocol}//${options.host}`)
    /* v8 ignore next 3 -- tests use default port configuration */
    if (typeof options.port === 'number') {
      url.port = String(options.port)
    }

    const body = JSON.stringify({
      name: input.event,
      channels: input.channels,
      data: JSON.stringify(input.payload),
      /* v8 ignore next -- tests do not pass socketId through the publish binding */
      ...(typeof input.socketId === 'undefined' ? {} : { socket_id: input.socketId }),
    })

    const bodyMd5 = createHash('md5').update(body).digest('hex')
    url.searchParams.set('auth_key', connection.key)
    url.searchParams.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
    url.searchParams.set('auth_version', '1.0')
    url.searchParams.set('body_md5', bodyMd5)
    url.searchParams.set(
      'auth_signature',
      createHmac('sha256', connection.secret).update(
        [
          'POST',
          url.pathname,
          [...url.searchParams.entries()]
            .filter(([key]) => key !== 'auth_signature')
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&'),
        ].join('\n'),
      ).digest('hex'),
    )

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), BROADCAST_PUBLISH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`[@holo-js/core] Broadcast publish request timed out after ${BROADCAST_PUBLISH_TIMEOUT_MS}ms.`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      throw new Error(`[@holo-js/core] Broadcast publish request failed with status ${response.status}.`)
    }

    const result = await response.json() as {
      readonly deliveredChannels?: unknown
      readonly deliveredSockets?: unknown
    }

    return {
      connection: input.connection,
      driver: connection.driver,
      queued: context.queued,
      publishedChannels: Array.isArray(result.deliveredChannels)
        ? Object.freeze(result.deliveredChannels.map(value => String(value)))
        : Object.freeze([...input.channels]),
    }
  }

  Object.defineProperty(publish, CORE_BROADCAST_PUBLISHER_MARKER, {
    value: true,
  })

  return publish
}

function isCoreBroadcastPublisher(
  value: NonNullable<ReturnType<BroadcastModule['getBroadcastRuntimeBindings']>['publish']> | undefined,
): boolean {
  return typeof value === 'function'
    && CORE_BROADCAST_PUBLISHER_MARKER in value
}

function createNotificationMailText(message: {
  readonly greeting?: string
  readonly lines?: readonly string[]
  readonly action?: {
    readonly label: string
    readonly url: string
  }
}): string | undefined {
  const parts = [
    typeof message.greeting === 'string' ? message.greeting.trim() : undefined,
    ...(message.lines ?? []).map(line => line.trim()).filter(Boolean),
    message.action
      ? `${message.action.label}: ${message.action.url}`
      : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function createCoreNotificationMailSender(
  mailModule: MailModule,
): {
  send(message: {
    readonly subject: string
    readonly greeting?: string
    readonly lines?: readonly string[]
    readonly action?: {
      readonly label: string
      readonly url: string
    }
    readonly html?: string
    readonly text?: string
    readonly metadata?: Readonly<Record<string, unknown>>
  }, context: {
    readonly route?: string | { readonly email: string, readonly name?: string }
  }): Promise<void>
} {
  return Object.freeze({
    async send(message, context): Promise<void> {
      const route = context.route
      if (!route) {
        throw new Error('[@holo-js/core] Email notifications require a resolved email route before bridging into mail.')
      }

      const fallbackText = createNotificationMailText(message)
      await mailModule.sendMail({
        to: route,
        subject: message.subject,
        ...(typeof message.html === 'string' ? { html: message.html } : {}),
        ...(typeof (message.text ?? fallbackText) === 'string'
          ? { text: (message.text ?? fallbackText)! }
          : {}),
        ...(typeof message.html !== 'string' && typeof (message.text ?? fallbackText) === 'string'
          ? { text: (message.text ?? fallbackText)! }
          : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      })
    },
  })
}

function createAuthMailDeliveryHook(
  mailModule: MailModule,
): {
  sendEmailVerification(input: {
    readonly provider: string
    readonly user: unknown
    readonly email: string
    readonly token: {
      readonly id: string
      readonly plainTextToken: string
      readonly expiresAt: Date
    }
  }): Promise<void>
  sendPasswordReset(input: {
    readonly provider: string
    readonly email: string
    readonly token: {
      readonly id: string
      readonly plainTextToken: string
      readonly expiresAt: Date
    }
  }): Promise<void>
} {
  return Object.freeze({
    async sendEmailVerification(input): Promise<void> {
      const recipientName = typeof (input.user as { name?: unknown })?.name === 'string'
        ? (input.user as { name?: string }).name?.trim()
        : undefined

      await mailModule.sendMail({
        to: {
          email: input.email,
          ...(recipientName ? { name: recipientName } : {}),
        },
        subject: 'Verify your email address',
        text: [
          recipientName ? `Hello ${recipientName},` : undefined,
          'Use this token to verify your email address:',
          input.token.plainTextToken,
          `Provider: ${input.provider}`,
          `Expires at: ${input.token.expiresAt.toISOString()}`,
        ].filter((value): value is string => typeof value === 'string').join('\n\n'),
        metadata: {
          provider: input.provider,
          tokenId: input.token.id,
        },
      })
    },
    async sendPasswordReset(input): Promise<void> {
      await mailModule.sendMail({
        to: input.email,
        subject: 'Reset your password',
        text: [
          'Use this token to reset your password:',
          input.token.plainTextToken,
          `Provider: ${input.provider}`,
          `Expires at: ${input.token.expiresAt.toISOString()}`,
        ].join('\n\n'),
        metadata: {
          provider: input.provider,
          tokenId: input.token.id,
        },
      })
    },
  })
}

async function loadConfiguredSocialProviders<TCustom extends HoloConfigMap>(
  projectRootOrLoadedConfig: string | LoadedHoloConfig<TCustom>,
  maybeLoadedConfig?: LoadedHoloConfig<TCustom>,
): Promise<Readonly<Record<string, unknown>>> {
  const projectRoot = typeof projectRootOrLoadedConfig === 'string'
    ? projectRootOrLoadedConfig
    : process.cwd()
  const loadedConfig = (typeof projectRootOrLoadedConfig === 'string'
    ? maybeLoadedConfig
    : projectRootOrLoadedConfig) as LoadedHoloConfig<TCustom> | undefined
  const socialConfig = loadedConfig?.auth?.social ?? {}
  const providers: Record<string, unknown> = {}

  for (const providerName of Object.keys(socialConfig)) {
    const configuredRuntime = socialConfig[providerName]?.runtime?.trim()
    const packageName = configuredRuntime || `@holo-js/auth-social-${providerName}`

    const moduleValue = await portableRuntimeModuleInternals.importOptionalModule<Record<string, unknown>>(packageName, {
      projectRoot,
    })
    if (!moduleValue) {
      throw new Error(`[@holo-js/core] Social provider "${providerName}" requires ${packageName} to be installed.`)
    }

    const runtime = moduleValue.default
      ?? moduleValue[`${providerName}SocialProvider`]
      ?? moduleValue.socialProvider
    if (!runtime) {
      throw new Error(`[@holo-js/core] Social provider package "${packageName}" did not export a runtime.`)
    }

    providers[providerName] = runtime
  }

  return Object.freeze(providers)
}

function normalizeDateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function normalizeStoredUserId(value: unknown): string | number {
  return typeof value === 'number' ? value : String(value)
}

function normalizeAccessTokenRecord(row: Record<string, unknown>): {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly name: string
  readonly abilities: readonly string[]
  readonly tokenHash: string
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
} {
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

function serializeAccessTokenRecord(record: {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly name: string
  readonly abilities: readonly string[]
  readonly tokenHash: string
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
}): Record<string, unknown> {
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

function normalizeEmailVerificationTokenRecord(row: Record<string, unknown>): {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
} {
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

function serializeEmailVerificationTokenRecord(record: {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}): Record<string, unknown> {
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

function normalizePasswordResetTokenRecord(row: Record<string, unknown>): {
  readonly id: string
  readonly provider: string
  readonly email: string
  readonly table?: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
} {
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

function serializePasswordResetTokenRecord(record: {
  readonly id: string
  readonly provider: string
  readonly email: string
  readonly table?: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}): Record<string, unknown> {
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

async function createCoreSocialBindings<TCustom extends HoloConfigMap>(
  projectRootOrLoadedConfig: string | LoadedHoloConfig<TCustom>,
  loadedConfigOrSessionModule: LoadedHoloConfig<TCustom> | SessionModule,
  maybeSessionModule?: SessionModule,
): Promise<{
  readonly providers: Readonly<Record<string, unknown>>
  readonly stateStore: {
    create(record: {
      readonly provider: string
      readonly state: string
      readonly codeVerifier: string
      readonly guard: string
      readonly createdAt: Date
    }): Promise<void>
    read(provider: string, state: string): Promise<{
      readonly provider: string
      readonly state: string
      readonly codeVerifier: string
      readonly guard: string
      readonly createdAt: Date
    } | null>
    delete(provider: string, state: string): Promise<void>
  }
  readonly identityStore: {
    findByProviderUserId(provider: string, providerUserId: string): Promise<unknown | null>
    save(record: unknown): Promise<void>
  }
}> {
  const projectRoot = typeof projectRootOrLoadedConfig === 'string'
    ? projectRootOrLoadedConfig
    : process.cwd()
  const loadedConfig = (typeof projectRootOrLoadedConfig === 'string'
    ? loadedConfigOrSessionModule
    : projectRootOrLoadedConfig) as LoadedHoloConfig<TCustom>
  const sessionModule = (typeof projectRootOrLoadedConfig === 'string'
    ? maybeSessionModule
    : loadedConfigOrSessionModule) as SessionModule
  const providers = await loadConfiguredSocialProviders(projectRoot, loadedConfig)
  const sessionRuntime = sessionModule.getSessionRuntime()
  const stateStore = Object.freeze({
    async create(record: {
      readonly provider: string
      readonly state: string
      readonly codeVerifier: string
      readonly guard: string
      readonly createdAt: Date
    }) {
      await sessionRuntime.create({
        id: `oauth:${record.provider}:${record.state}`,
        data: {
          provider: record.provider,
          state: record.state,
          codeVerifier: record.codeVerifier,
          guard: record.guard,
          createdAt: record.createdAt.toISOString(),
        },
      })
    },
    async read(provider: string, state: string) {
      const record = await sessionRuntime.read(`oauth:${provider}:${state}`)
      if (!record || typeof record !== 'object' || !('data' in record)) {
        return null
      }

      const data = (record as { data?: Record<string, unknown> }).data
      if (!data || typeof data.codeVerifier !== 'string' || typeof data.guard !== 'string') {
        return null
      }

      return {
        provider,
        state,
        codeVerifier: data.codeVerifier,
        guard: data.guard,
        createdAt: normalizeDateValue(data.createdAt ?? new Date()),
      }
    },
    async delete(provider: string, state: string) {
      await sessionRuntime.invalidate(`oauth:${provider}:${state}`)
    },
  })
  const identityStore = Object.freeze({
    async findByProviderUserId(provider: string, providerUserId: string) {
      const row = await DB.table('auth_identities')
        .where('provider', provider)
        .where('provider_user_id', providerUserId)
        .first<Record<string, unknown>>()
      if (!row) {
        return null
      }

      return {
        provider: String(row.provider ?? provider),
        providerUserId: String(row.provider_user_id ?? providerUserId),
        guard: String(row.guard ?? loadedConfig.auth.defaults.guard),
        authProvider: String(
          row.auth_provider
          ?? loadedConfig.auth.guards[String(row.guard ?? loadedConfig.auth.defaults.guard)]?.provider
          ?? loadedConfig.auth.guards[loadedConfig.auth.defaults.guard]?.provider
          ?? 'users',
        ),
        userId: normalizeStoredUserId(row.user_id),
        email: typeof row.email === 'string' ? row.email : undefined,
        emailVerified: row.email_verified === true || row.email_verified === 1 || row.email_verified === '1',
        profile: typeof normalizeJsonValue(row.profile) === 'object' && normalizeJsonValue(row.profile)
          ? normalizeJsonValue(row.profile) as Record<string, unknown>
          : {},
        tokens: normalizeJsonValue(row.tokens),
        linkedAt: normalizeDateValue(row.created_at ?? new Date()),
        updatedAt: normalizeDateValue(row.updated_at ?? new Date()),
      }
    },
    async save(record: unknown) {
      const value = record as {
        readonly provider: string
        readonly providerUserId: string
        readonly guard: string
        readonly authProvider: string
        readonly userId: string | number
        readonly email?: string
        readonly emailVerified: boolean
        readonly profile: Readonly<Record<string, unknown>>
        readonly tokens?: unknown
        readonly linkedAt: Date
        readonly updatedAt: Date
      }
      const existing = await DB.table('auth_identities')
        .where('provider', value.provider)
        .where('provider_user_id', value.providerUserId)
        .first<Record<string, unknown>>()
      const payload = {
        user_id: String(value.userId),
        provider: value.provider,
        provider_user_id: value.providerUserId,
        guard: value.guard,
        auth_provider: value.authProvider,
        email: value.email ?? null,
        email_verified: value.emailVerified ? 1 : 0,
        profile: JSON.stringify(value.profile),
        tokens: JSON.stringify(value.tokens ?? {}),
        created_at: value.linkedAt.toISOString(),
        updated_at: value.updatedAt.toISOString(),
      }

      if (existing && typeof existing.id !== 'undefined') {
        await DB.table('auth_identities').where('id', existing.id).update(payload)
        return
      }

      await DB.table('auth_identities').insert(payload)
    },
  })

  return Object.freeze({
    providers,
    stateStore,
    identityStore,
  })
}

function toHostedIdentityProviderValue(namespace: string, provider: string): string {
  return `${namespace}:${provider}`
}

function fromHostedIdentityProviderValue(namespace: string, provider: string): string {
  const prefix = `${namespace}:`
  return provider.startsWith(prefix) ? provider.slice(prefix.length) : provider
}

function createCoreHostedIdentityStore(namespace: string): {
  findByProviderUserId(provider: string, providerUserId: string): Promise<unknown | null>
  findByUserId(provider: string, authProvider: string, userId: string | number): Promise<unknown | null>
  save(record: unknown): Promise<void>
} {
  return Object.freeze({
    async findByProviderUserId(provider: string, providerUserId: string) {
      const providerValue = toHostedIdentityProviderValue(namespace, provider)
      const row = await DB.table('auth_identities')
        .where('provider', providerValue)
        .where('provider_user_id', providerUserId)
        .first<Record<string, unknown>>()
      if (!row) {
        return null
      }

      /* v8 ignore start -- external identity rows may omit fields; these defaults are defensive normalization guards. */
      return {
        provider: fromHostedIdentityProviderValue(namespace, String(row.provider ?? provider)),
        providerUserId: String(row.provider_user_id ?? providerUserId),
        guard: String(row.guard ?? 'web'),
        authProvider: String(row.auth_provider ?? 'users'),
        userId: normalizeStoredUserId(row.user_id),
        email: typeof row.email === 'string' ? row.email : undefined,
        emailVerified: row.email_verified === true || row.email_verified === 1 || row.email_verified === '1',
        profile: typeof normalizeJsonValue(row.profile) === 'object' && normalizeJsonValue(row.profile)
          ? normalizeJsonValue(row.profile) as Record<string, unknown>
          /* v8 ignore next -- external identity rows with missing or malformed profiles normalize to an empty object. */
          : {},
        linkedAt: normalizeDateValue(row.created_at ?? new Date()),
        updatedAt: normalizeDateValue(row.updated_at ?? new Date()),
      }
      /* v8 ignore stop */
    },
    async findByUserId(provider: string, authProvider: string, userId: string | number) {
      const providerValue = toHostedIdentityProviderValue(namespace, provider)
      const row = await DB.table('auth_identities')
        .where('provider', providerValue)
        .where('auth_provider', authProvider)
        .where('user_id', String(userId))
        .first<Record<string, unknown>>()
      if (!row) {
        return null
      }

      /* v8 ignore start -- external identity rows may omit fields; these defaults are defensive normalization guards. */
      return {
        provider: fromHostedIdentityProviderValue(namespace, String(row.provider ?? provider)),
        providerUserId: String(row.provider_user_id),
        guard: String(row.guard ?? 'web'),
        authProvider: String(row.auth_provider ?? authProvider),
        userId: normalizeStoredUserId(row.user_id),
        email: typeof row.email === 'string' ? row.email : undefined,
        emailVerified: row.email_verified === true || row.email_verified === 1 || row.email_verified === '1',
        profile: typeof normalizeJsonValue(row.profile) === 'object' && normalizeJsonValue(row.profile)
          ? normalizeJsonValue(row.profile) as Record<string, unknown>
          /* v8 ignore next -- external identity rows with missing or malformed profiles normalize to an empty object. */
          : {},
        linkedAt: normalizeDateValue(row.created_at ?? new Date()),
        updatedAt: normalizeDateValue(row.updated_at ?? new Date()),
      }
      /* v8 ignore stop */
    },
    async save(record: unknown) {
      const value = record as {
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
      const providerValue = toHostedIdentityProviderValue(namespace, value.provider)
      const existing = await DB.table('auth_identities')
        .where('provider', providerValue)
        .where('provider_user_id', value.providerUserId)
        .first<Record<string, unknown>>()
      const payload = {
        user_id: String(value.userId),
        provider: providerValue,
        provider_user_id: value.providerUserId,
        guard: value.guard,
        auth_provider: value.authProvider,
        email: value.email ?? null,
        email_verified: value.emailVerified ? 1 : 0,
        profile: JSON.stringify(value.profile),
        created_at: value.linkedAt.toISOString(),
        updated_at: value.updatedAt.toISOString(),
      }

      if (existing && typeof existing.id !== 'undefined') {
        await DB.table('auth_identities').where('id', existing.id).update(payload)
        return
      }

      await DB.table('auth_identities').insert(payload)
    },
  })
}

function createCoreAuthStores<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): {
  readonly tokens: {
    create(record: unknown): Promise<void>
    findById(id: string): Promise<unknown | null>
    listByUserId(provider: string, userId: string | number): Promise<readonly unknown[]>
    update(record: unknown): Promise<void>
    delete(id: string): Promise<void>
    deleteByUserId(provider: string, userId: string | number): Promise<number>
  }
  readonly emailVerificationTokens: {
    create(record: unknown): Promise<void>
    findById(id: string): Promise<unknown | null>
    delete(id: string): Promise<void>
    deleteByUserId(provider: string, userId: string | number): Promise<number>
  }
  readonly passwordResetTokens: {
    create(record: unknown): Promise<void>
    findById(id: string): Promise<unknown | null>
    findLatestByEmail(
      provider: string,
      email: string,
      options?: { readonly table?: string },
    ): Promise<unknown | null>
    delete(id: string, options?: { readonly table?: string }): Promise<void>
    deleteByEmail(provider: string, email: string, options?: { readonly table?: string }): Promise<number>
  }
} {
  return Object.freeze({
    tokens: Object.freeze({
      async create(record: unknown) {
        await DB.table('personal_access_tokens').insert(serializeAccessTokenRecord(record as {
          readonly id: string
          readonly provider: string
          readonly userId: string | number
          readonly name: string
          readonly abilities: readonly string[]
          readonly tokenHash: string
          readonly createdAt: Date
          readonly lastUsedAt?: Date
          readonly expiresAt?: Date | null
        }))
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
      async update(record: unknown) {
        const payload = serializeAccessTokenRecord(record as {
          readonly id: string
          readonly provider: string
          readonly userId: string | number
          readonly name: string
          readonly abilities: readonly string[]
          readonly tokenHash: string
          readonly createdAt: Date
          readonly lastUsedAt?: Date
          readonly expiresAt?: Date | null
        })
        await DB.table('personal_access_tokens').where('id', String(payload.id)).update(payload)
      },
      async delete(id: string) {
        await DB.table('personal_access_tokens').where('id', id).delete()
      },
      async deleteByUserId(provider: string, userId: string | number) {
        const result = await DB.table('personal_access_tokens')
          .where('provider', provider)
          .where('user_id', String(userId))
          .delete()
        /* v8 ignore next -- DB adapters that omit affectedRows normalize to 0. */
        return result.affectedRows ?? 0
      },
    }),
    emailVerificationTokens: Object.freeze({
      async create(record: unknown) {
        await DB.table('email_verification_tokens').insert(serializeEmailVerificationTokenRecord(record as {
          readonly id: string
          readonly provider: string
          readonly userId: string | number
          readonly email: string
          readonly tokenHash: string
          readonly createdAt: Date
          readonly expiresAt: Date
        }))
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
        /* v8 ignore next -- DB adapters that omit affectedRows normalize to 0. */
        return result.affectedRows ?? 0
      },
    }),
    passwordResetTokens: Object.freeze({
      async create(record: unknown) {
        const value = record as {
          readonly id: string
          readonly provider: string
          readonly email: string
          readonly table?: string
          readonly tokenHash: string
          readonly createdAt: Date
          readonly expiresAt: Date
        }
        await DB.table(value.table ?? 'password_reset_tokens').insert(serializePasswordResetTokenRecord(value))
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
        /* v8 ignore next -- callers usually pass the broker table; omitted options normalize to the default password reset table. */
        const table = options?.table ?? 'password_reset_tokens'
        await DB.table(table).where('id', id).delete()
      },
      async deleteByEmail(provider: string, email: string, options?: { readonly table?: string }) {
        const table = options?.table ?? 'password_reset_tokens'
        const result = await DB.table(table)
          .where('provider', provider)
          .where('email', email)
          .delete()
        /* v8 ignore next -- DB adapters that omit affectedRows normalize to 0. */
        return result.affectedRows ?? 0
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
      const moduleValue = await importRuntimeModule(projectRoot, candidate) as {
        default?: unknown
        holoModelPendingSchema?: boolean
      }
      if ('default' in moduleValue) {
        return moduleValue
      }
    } catch (error) {
      /* v8 ignore start -- alternate runtime import failure shapes depend on Node/vite loader behavior */
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
      /* v8 ignore next -- unknown import failures are rethrown verbatim for visibility */
      throw error
    }
    /* v8 ignore stop */
  }

  throw new Error(`[@holo-js/core] Auth provider model "${modelName}" could not be resolved from ${modelsRoot}.`)
}

async function createCoreAuthProviders<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
): Promise<Readonly<Record<string, unknown>>> {
  const providers = Object.entries(loadedConfig.auth.providers)

  return Object.freeze(Object.fromEntries(await Promise.all(providers.map(async ([providerName, providerConfig]) => {
    type AuthModelQuery = {
      where(column: string, value: unknown): AuthModelQuery
      first(): Promise<unknown>
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
        readonly fillable?: readonly string[]
        readonly guarded?: readonly string[]
        readonly hasExplicitFillable?: boolean
      }
      query?(): AuthModelQuery
      find(value: unknown): Promise<unknown>
      where(column: string, value: unknown): AuthModelQuery
      create(values: Record<string, unknown>): Promise<unknown>
      update(id: unknown, values: Record<string, unknown>): Promise<unknown>
    }
    const throwPendingSchema = (): never => {
      throw new Error(
        `[@holo-js/core] Auth provider model "${providerConfig.model}" is pending generated schema output. `
        + 'Run the schema generator before using auth.',
      )
    }

    if (typeof model === 'undefined' && resolvedModule.holoModelPendingSchema === true) {
      const pendingAdapter = {
        async findById() {
          throwPendingSchema()
        },
        async findByCredentials() {
          throwPendingSchema()
        },
        async create() {
          throwPendingSchema()
        },
        async update() {
          throwPendingSchema()
        },
        matchesUser() {
          return false
        },
        getId() {
          throwPendingSchema()
        },
        getPasswordHash() {
          throwPendingSchema()
        },
        getEmailVerifiedAt() {
          throwPendingSchema()
        },
        serialize() {
          throwPendingSchema()
        },
      }

      return [providerName, pendingAdapter] as const
    }

    const sanitizeAuthWriteInput = (
      input: Readonly<Record<string, unknown>>,
      options: {
        readonly enforceFillable?: boolean
      } = {},
    ): Record<string, unknown> => {
      const definition = model.definition
      const knownColumns = new Set(Object.keys(definition?.table?.columns ?? {}))
      const fillable = new Set(definition?.fillable ?? [])
      const guarded = new Set(definition?.guarded ?? [])
      const hasKnownColumns = knownColumns.size > 0
      const enforceFillable = options.enforceFillable !== false
      const output: Record<string, unknown> = {}

      for (const [column, value] of Object.entries(input)) {
        if (hasKnownColumns && !knownColumns.has(column)) {
          continue
        }

        if (guarded.has('*')) {
          continue
        }

        const writable = !enforceFillable
          ? !guarded.has(column)
          : fillable.has('*')
            ? !guarded.has(column)
            : definition?.hasExplicitFillable === true || fillable.size > 0
              ? fillable.has(column) && !guarded.has(column)
              : !guarded.has(column)

        if (writable) {
          output[column] = value
        }
      }

      return output
    }

    const prepareAuthCreateInput = async (input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const sanitizedInput = sanitizeAuthWriteInput(input)
      if (typeof resolvedModule.prepareAuthCreateInput !== 'function') {
        return sanitizedInput
      }

      return sanitizeAuthWriteInput(await resolvedModule.prepareAuthCreateInput(sanitizedInput), {
        enforceFillable: false,
      })
    }

    const prepareAuthUpdateInput = async (
      user: unknown,
      input: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const sanitizedInput = sanitizeAuthWriteInput(input)
      if (typeof resolvedModule.prepareAuthUpdateInput !== 'function') {
        return sanitizedInput
      }

      return sanitizeAuthWriteInput(await resolvedModule.prepareAuthUpdateInput(user, sanitizedInput), {
        enforceFillable: false,
      })
    }

    const adapter = {
      async findById(id: string | number) {
        const resolved = await model.find(id)
        /* v8 ignore next -- model.find() may return undefined in loose userland adapters; core normalizes it to null */
        return resolved ? markProviderUser(resolved, providerName) : null
      },
      async findByCredentials(credentials: Readonly<Record<string, unknown>>) {
        const entries = Object.entries(credentials)
        if (entries.length === 0) {
          return null
        }

        if (typeof model.query === 'function') {
          let query = model.query()
          for (const [column, value] of entries) {
            query = query.where(column, value)
          }
          const resolved = await query.first()
          return resolved ? markProviderUser(resolved, providerName) : null
        }

        let query = model.where(entries[0]![0], entries[0]![1])
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
        return markProviderUser(await model.create(await prepareAuthCreateInput(input)), providerName)
      },
      /* v8 ignore start -- adapter shape mirrors the auth package contract; core tests cover the wired runtime behavior */
      async update(user: unknown, input: Readonly<Record<string, unknown>>) {
        return markProviderUser(
          await model.update(getEntityAttributes(user).id, await prepareAuthUpdateInput(user, input)),
          providerName,
        )
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
          ? (user as { toJSON(): unknown }).toJSON()
          : { ...getEntityAttributes(user) }
        Object.defineProperty(serialized, HOLO_AUTH_PROVIDER_MARKER, {
          value: providerName,
          enumerable: false,
          configurable: true,
        })
        return serialized
      },
      /* v8 ignore stop */
    }

    return [providerName, adapter] as const
  }))))
}

async function importRuntimeModule(projectRoot: string, filePath: string): Promise<unknown> {
  return importBundledRuntimeModule(projectRoot, filePath)
}

async function registerProjectQueueJobs(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
  queueModule: QueueModule,
): Promise<readonly string[]> {
  /* v8 ignore next 4 -- initialization short-circuits before calling this helper when no jobs are present */
  if (!registry || registry.jobs.length === 0) {
    return Object.freeze([])
  }

  const registeredJobNames: string[] = []
  try {
    for (const entry of registry.jobs) {
      const existing = queueModule.getRegisteredQueueJob(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const job = resolveQueueJobExport(queueModule, moduleValue)
      if (!job) {
        throw new Error(`Discovered job "${entry.sourcePath}" does not export a Holo job.`)
      }

      queueModule.registerQueueJob(queueModule.normalizeQueueJobDefinition(job), {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredJobNames.push(entry.name)
    }
  } catch (error) {
    unregisterProjectQueueJobs(queueModule, registeredJobNames)
    throw error
  }

  return Object.freeze(registeredJobNames)
}

function unregisterProjectQueueJobs(
  queueModule: QueueModule | undefined,
  jobNames: readonly string[],
): void {
  if (!queueModule) {
    return
  }

  for (const jobName of jobNames) {
    queueModule.unregisterQueueJob(jobName)
  }
}

function withCanonicalAuthorizationDefinitionName<TDefinition extends { readonly name: string }>(
  definition: TDefinition,
  name: string,
): TDefinition {
  if (definition.name === name) {
    return definition
  }

  return {
    ...definition,
    name,
  }
}

function withCanonicalAuthorizationAbilityName<TDefinition extends { readonly name: string }>(
  definition: TDefinition,
  name: string,
): TDefinition {
  if (definition.name === name) {
    return definition
  }

  return {
    ...definition,
    name,
  }
}

async function registerProjectAuthorizationDefinitions(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
  authorizationModule: AuthorizationModule | undefined,
): Promise<{ readonly policyNames: readonly string[], readonly abilityNames: readonly string[] }> {
  if (!registry || (!registry.authorizationPolicies.length && !registry.authorizationAbilities.length)) {
    return Object.freeze({
      policyNames: Object.freeze([]),
      abilityNames: Object.freeze([]),
    })
  }

  if (!authorizationModule) {
    throw new Error('[@holo-js/core] Authorization support requires @holo-js/authorization to be installed.')
  }

  const registeredPolicyNames: string[] = []
  const registeredAbilityNames: string[] = []
  const previousPolicies = new Map<string, unknown>()
  const previousAbilities = new Map<string, unknown>()

  try {
    for (const entry of registry.authorizationPolicies) {
      const existing = authorizationModule.authorizationInternals.getAuthorizationRuntimeState().policiesByName.get(entry.name)
      if (existing) {
        previousPolicies.set(entry.name, existing)
        authorizationModule.authorizationInternals.unregisterPolicyDefinition(entry.name)
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const policy = resolveAuthorizationDefinitionExport(
        moduleValue,
        entry.exportName,
        value => authorizationModule.isAuthorizationPolicyDefinition(value),
      )
      if (!policy) {
        throw new Error(`Discovered policy "${entry.sourcePath}" does not export a Holo policy.`)
      }

      const canonicalPolicy = withCanonicalAuthorizationDefinitionName(
        policy as { readonly name: string },
        entry.name,
      )
      const resolvedPolicyName = (policy as { readonly name: string }).name
      if (resolvedPolicyName !== entry.name) {
        authorizationModule.authorizationInternals.unregisterPolicyDefinition(resolvedPolicyName)
      }

      if (
        typeof authorizationModule.authorizationInternals.registerPolicyDefinition === 'function'
        && !authorizationModule.authorizationInternals.getAuthorizationRuntimeState().policiesByName.has(entry.name)
      ) {
        authorizationModule.authorizationInternals.registerPolicyDefinition(canonicalPolicy)
      }

      registeredPolicyNames.push(entry.name)
    }

    for (const entry of registry.authorizationAbilities) {
      const existing = authorizationModule.authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.get(entry.name)
      if (existing) {
        previousAbilities.set(entry.name, existing)
        authorizationModule.authorizationInternals.unregisterAbilityDefinition(entry.name)
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const ability = resolveAuthorizationDefinitionExport(
        moduleValue,
        entry.exportName,
        value => authorizationModule.isAuthorizationAbilityDefinition(value),
      )
      if (!ability) {
        throw new Error(`Discovered ability "${entry.sourcePath}" does not export a Holo ability.`)
      }

      const canonicalAbility = withCanonicalAuthorizationAbilityName(
        ability as { readonly name: string },
        entry.name,
      )
      const resolvedAbilityName = (ability as { readonly name: string }).name
      if (resolvedAbilityName !== entry.name) {
        authorizationModule.authorizationInternals.unregisterAbilityDefinition(resolvedAbilityName)
      }

      if (
        typeof authorizationModule.authorizationInternals.registerAbilityDefinition === 'function'
        && !authorizationModule.authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has(entry.name)
      ) {
        authorizationModule.authorizationInternals.registerAbilityDefinition(canonicalAbility)
      }

      registeredAbilityNames.push(entry.name)
    }
  } catch (error) {
    unregisterProjectAuthorizationDefinitions(authorizationModule, registeredPolicyNames, registeredAbilityNames)
    if (typeof authorizationModule.authorizationInternals.registerPolicyDefinition === 'function') {
      for (const definition of previousPolicies.values()) {
        authorizationModule.authorizationInternals.registerPolicyDefinition(definition)
      }
    }
    if (typeof authorizationModule.authorizationInternals.registerAbilityDefinition === 'function') {
      for (const definition of previousAbilities.values()) {
        authorizationModule.authorizationInternals.registerAbilityDefinition(definition)
      }
    }
    throw error
  }

  return Object.freeze({
    policyNames: Object.freeze(registeredPolicyNames),
    abilityNames: Object.freeze(registeredAbilityNames),
  })
}

function unregisterProjectAuthorizationDefinitions(
  authorizationModule: AuthorizationModule | undefined,
  policyNames: readonly string[],
  abilityNames: readonly string[],
): void {
  if (!authorizationModule) {
    return
  }

  for (const policyName of policyNames) {
    authorizationModule.authorizationInternals.unregisterPolicyDefinition(policyName)
  }

  for (const abilityName of abilityNames) {
    authorizationModule.authorizationInternals.unregisterAbilityDefinition(abilityName)
  }
}

async function registerProjectEventsAndListeners(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
  eventsModule: EventsModule,
  queueModule: QueueModule | undefined,
): Promise<{ readonly eventNames: readonly string[], readonly listenerIds: readonly string[] }> {
  /* v8 ignore next 6 -- initialization short-circuits before calling this helper when no events or listeners are present */
  if (!registry || (registry.events.length === 0 && registry.listeners.length === 0)) {
    return Object.freeze({
      eventNames: Object.freeze([]),
      listenerIds: Object.freeze([]),
    })
  }

  const registeredEventNames: string[] = []
  const registeredListenerIds: string[] = []
  let requiresQueuedListeners = false

  try {
    for (const entry of registry.events) {
      const existing = eventsModule.getRegisteredEvent(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const event = resolveEventExport(moduleValue)
      if (!event || !eventsModule.isEventDefinition(event)) {
        throw new Error(`Discovered event "${entry.sourcePath}" does not export a Holo event.`)
      }

      eventsModule.registerEvent(event, {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredEventNames.push(entry.name)
    }

    for (const entry of registry.listeners) {
      const existing = eventsModule.getRegisteredListener(entry.id)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const listener = resolveListenerExport(eventsModule, moduleValue)
      if (!listener) {
        throw new Error(`Discovered listener "${entry.sourcePath}" does not export a Holo listener.`)
      }

      const normalizedListener = eventsModule.normalizeListenerDefinition(listener)
      if (normalizedListener.queue === true) {
        requiresQueuedListeners = true
        /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
        if (!queueModule) {
          throw new Error('[@holo-js/core] Queued listeners require @holo-js/queue to be installed.')
        }
        /* v8 ignore stop */
      }

      eventsModule.registerListener({
        ...normalizedListener,
        listensTo: entry.eventNames,
      }, {
        id: entry.id,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredListenerIds.push(entry.id)
    }

    if (requiresQueuedListeners) {
      await eventsModule.ensureEventsQueueJobRegisteredAsync?.()
    }
  } catch (error) {
    unregisterProjectEventsAndListeners(eventsModule, registeredEventNames, registeredListenerIds)
    throw error
  }

  return Object.freeze({
    eventNames: Object.freeze(registeredEventNames),
    listenerIds: Object.freeze(registeredListenerIds),
  })
}

function unregisterProjectEventsAndListeners(
  eventsModule: EventsModule | undefined,
  eventNames: readonly string[],
  listenerIds: readonly string[],
): void {
  if (!eventsModule) {
    return
  }

  for (const listenerId of listenerIds) {
    eventsModule.unregisterListener(listenerId)
  }

  for (const eventName of eventNames) {
    eventsModule.unregisterEvent(eventName)
  }
}

export async function reconfigureOptionalHoloSubsystems<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  options: {
    readonly renderView?: HoloServerViewRenderer
  } = {},
): Promise<{
  readonly queueModule?: QueueModule
  readonly session?: HoloSessionRuntimeBinding
  readonly auth?: HoloAuthRuntimeBinding
  readonly authContext?: {
    activate(): void
  }
}> {
  const queueConfigured = hasLoadedConfigFile(loadedConfig, 'queue')
  const queueModule = await loadQueueModule(queueConfigured)
  if (queueModule) {
    const queueUsesExplicitDatabaseFeatures = queueConfigured
      && (
        queueConfigUsesDatabaseDriver(loadedConfig)
        || queueConfigUsesDatabaseBackedFailedStore(loadedConfig)
      )
    const queueUsesImplicitDefaultFailedStore = !queueConfigured
      && queueConfigUsesDatabaseBackedFailedStore(loadedConfig)
    const queueDbModule = (queueUsesExplicitDatabaseFeatures || queueUsesImplicitDefaultFailedStore)
      ? await loadQueueDbModule()
      : undefined

    /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
    if (queueUsesExplicitDatabaseFeatures && !queueDbModule) {
      throw new Error('[@holo-js/core] Database-backed queue features require @holo-js/queue-db to be installed.')
    }
    /* v8 ignore stop */

    queueModule.configureQueueRuntime({
      config: loadedConfig.queue,
      ...(queueDbModule?.createQueueDbRuntimeOptions() ?? {}),
    })
  }

  const storageConfigured = hasLoadedConfigFile(loadedConfig, 'storage')
  const storageInstalled = !!await portableRuntimeModuleInternals.importOptionalModule<Record<string, unknown>>('@holo-js/storage')
  /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!storageInstalled && storageConfigured) {
    throw new Error('[@holo-js/core] Storage support requires @holo-js/storage to be installed.')
  }
  /* v8 ignore stop */

  if (storageInstalled) {
    await configurePlainNodeStorageRuntime(projectRoot, loadedConfig)
  }

  const mailConfigured = hasLoadedConfigFile(loadedConfig, 'mail')
  const mailModule = mailConfigured
    ? await loadMailModule(true)
    : undefined
  if (mailModule) {
    const existingMailBindings = mailModule.getMailRuntimeBindings()
    mailModule.configureMailRuntime({
      ...existingMailBindings,
      config: loadedConfig.mail,
      ...(options.renderView ?? getRuntimeState().renderView
        ? { renderView: options.renderView ?? getRuntimeState().renderView }
        : {}),
    })
  }

  const broadcastConfigured = hasLoadedConfigFile(loadedConfig, 'broadcast')
  const broadcastModule = broadcastConfigured
    ? await loadBroadcastModule(true, projectRoot)
    : undefined
  if (broadcastModule) {
    const existingBroadcastBindings = broadcastModule.getBroadcastRuntimeBindings()
    broadcastModule.configureBroadcastRuntime({
      ...existingBroadcastBindings,
      config: loadedConfig.broadcast,
      ...(!existingBroadcastBindings.publish || isCoreBroadcastPublisher(existingBroadcastBindings.publish)
        ? {
            publish: createCoreBroadcastPublisher(loadedConfig.broadcast),
          }
        : {}),
    })
  }

  const notificationsConfigured = hasLoadedConfigFile(loadedConfig, 'notifications')
  const notificationsModule = notificationsConfigured
    ? await loadNotificationsModule(true)
    : undefined
  if (notificationsModule) {
    const existingNotificationsBindings = notificationsModule.getNotificationsRuntimeBindings()
    notificationsModule.configureNotificationsRuntime({
      ...existingNotificationsBindings,
      config: loadedConfig.notifications,
      store: existingNotificationsBindings.store ?? createCoreNotificationStore(loadedConfig),
      ...(!existingNotificationsBindings.mailer && mailModule
        ? { mailer: createCoreNotificationMailSender(mailModule) }
        : {}),
      ...(!existingNotificationsBindings.broadcaster && broadcastModule
        ? { broadcaster: createCoreNotificationBroadcaster(broadcastModule) }
        : {}),
    })
  }

  const notificationsRuntimeBindings = notificationsModule?.getNotificationsRuntimeBindings()

  const sessionConfigured = hasLoadedConfigFile(loadedConfig, 'session') || hasLoadedConfigFile(loadedConfig, 'auth')
  const authConfigured = hasLoadedConfigFile(loadedConfig, 'auth')
  const securityConfigured = hasLoadedConfigFile(loadedConfig, 'security')
  const securityModule = securityConfigured
    ? await loadSecurityModule(true)
    : undefined
  const existingManagedSecurityRedisAdapter = getRuntimeState().securityRedisAdapter

  if (securityModule) {
    const existingSecurityBindings = securityModule.getSecurityRuntimeBindings()
    const shouldReuseExistingSecurityStore = !!existingSecurityBindings?.rateLimitStore
      && !existingManagedSecurityRedisAdapter
      && getRuntimeState().securityRateLimitStoreManaged !== true
    const shouldCloseExistingManagedSecurityStore = !shouldReuseExistingSecurityStore
      && !!existingSecurityBindings?.rateLimitStore
      && (
        !!existingManagedSecurityRedisAdapter
        || getRuntimeState().securityRateLimitStoreManaged === true
      )
    let nextManagedSecurityRedisAdapter: SecurityRedisAdapter | undefined
    let rateLimitStore: ReturnType<typeof securityModule.createRateLimitStoreFromConfig> | undefined
    let configuredSecurityRuntime = false

    try {
      if (
        !shouldReuseExistingSecurityStore
        && loadedConfig.security.rateLimit.driver === 'redis'
      ) {
        const securityRedisAdapterModule = await loadSecurityRedisAdapterModule(true)
        nextManagedSecurityRedisAdapter = securityRedisAdapterModule.createSecurityRedisAdapter(
          loadedConfig.security.rateLimit.redis,
        )
      }

      rateLimitStore = shouldReuseExistingSecurityStore
        ? existingSecurityBindings.rateLimitStore
        : securityModule.createRateLimitStoreFromConfig(loadedConfig.security, {
          projectRoot,
          ...(nextManagedSecurityRedisAdapter ? { redisAdapter: nextManagedSecurityRedisAdapter } : {}),
        })

      if (
        shouldCloseExistingManagedSecurityStore
        && existingSecurityBindings?.rateLimitStore
        && existingSecurityBindings.rateLimitStore !== rateLimitStore
      ) {
        await existingSecurityBindings.rateLimitStore.close?.()
      }

      if (
        existingManagedSecurityRedisAdapter
        && existingManagedSecurityRedisAdapter !== nextManagedSecurityRedisAdapter
      ) {
        await existingManagedSecurityRedisAdapter.close?.()
      }

      getRuntimeState().securityRedisAdapter = nextManagedSecurityRedisAdapter
      getRuntimeState().securityRateLimitStoreManaged = !shouldReuseExistingSecurityStore

      securityModule.configureSecurityRuntime({
        config: loadedConfig.security,
        rateLimitStore,
        csrfSigningKey: loadedConfig.app.key,
        defaultKeyResolver: async () => {
          const authModule = await loadAuthModule()
          if (!authModule) {
            return undefined
          }

          try {
            const authId = await authModule.getAuthRuntime().id()
            if (authId !== null && typeof authId !== 'undefined') {
              return `user:${String(authId)}`
            }
          } catch {
            return undefined
          }

          return undefined
        },
      })
      configuredSecurityRuntime = true
    } catch (error) {
      if (
        !configuredSecurityRuntime
        && rateLimitStore
        && rateLimitStore !== existingSecurityBindings?.rateLimitStore
      ) {
        await rateLimitStore.close?.()
      }

      if (
        nextManagedSecurityRedisAdapter
        && nextManagedSecurityRedisAdapter !== existingManagedSecurityRedisAdapter
      ) {
        await nextManagedSecurityRedisAdapter.close?.()
      }

      throw error
    }
  } else if (existingManagedSecurityRedisAdapter || getRuntimeState().securityRateLimitStoreManaged === true) {
    const existingSecurityModule = await loadSecurityModule()
    const existingSecurityBindings = existingSecurityModule?.getSecurityRuntimeBindings()
    if (getRuntimeState().securityRateLimitStoreManaged === true) {
      await existingSecurityBindings?.rateLimitStore?.close?.()
    }
    await existingManagedSecurityRedisAdapter?.close?.()
    getRuntimeState().securityRedisAdapter = undefined
    getRuntimeState().securityRateLimitStoreManaged = undefined
    existingSecurityModule?.resetSecurityRuntime()
  } else {
    getRuntimeState().securityRateLimitStoreManaged = undefined
  }

  const sessionModule = sessionConfigured || authConfigured
    ? await loadSessionModule(true)
    : undefined
  const existingManagedSessionRedisAdapters = getRuntimeState().sessionRedisAdapters

  /* v8 ignore start -- redundant defensive guards after required-module loaders above */
  if (authConfigured && !sessionModule) {
    throw new Error('[@holo-js/core] Auth support requires @holo-js/session to be installed.')
  }

  const authModule = await loadAuthModule(authConfigured)
  const authorizationModule = await loadAuthorizationModule()
  let authContext: ReturnType<AuthModule['createAsyncAuthContext']> | undefined
  const workosModule = authConfigUsesWorkosProviders(loadedConfig)
    ? await loadWorkosModule(true)
    : undefined
  const clerkModule = authConfigUsesClerkProviders(loadedConfig)
    ? await loadClerkModule(true)
    : undefined

  if (sessionModule) {
    let managedSessionStores: Awaited<ReturnType<typeof createCoreManagedSessionStores>> | undefined

    try {
      managedSessionStores = await createCoreManagedSessionStores(projectRoot, loadedConfig, sessionModule)

      sessionModule.configureSessionRuntime({
        config: loadedConfig.session,
        stores: managedSessionStores.stores,
      })

      getRuntimeState().sessionRedisAdapters = managedSessionStores.redisAdapters.length > 0
        ? managedSessionStores.redisAdapters
        : undefined

      if (existingManagedSessionRedisAdapters) {
        await Promise.all(existingManagedSessionRedisAdapters.map(adapter => adapter.close?.()))
      }
    } catch (error) {
      if (managedSessionStores) {
        await Promise.all(managedSessionStores.redisAdapters.map(adapter => adapter.close?.()))
      }

      throw error
    }
  } else if (existingManagedSessionRedisAdapters) {
    await Promise.all(existingManagedSessionRedisAdapters.map(adapter => adapter.close?.()))
    getRuntimeState().sessionRedisAdapters = undefined
  }

  if (authConfigured) {
    if (!authModule) {
      throw new Error('[@holo-js/core] Auth support requires @holo-js/auth to be installed.')
    }
    if (!sessionModule) {
      throw new Error('[@holo-js/core] Auth support requires @holo-js/session to be installed.')
    }
    /* v8 ignore stop */

    const socialModule = authConfigUsesSocialProviders(loadedConfig)
      ? await loadSocialModule(true)
      : undefined
    const authStores = createCoreAuthStores(loadedConfig)

    authContext = authModule.createAsyncAuthContext()
    authModule.configureAuthRuntime({
      config: loadedConfig.auth,
      session: sessionModule.getSessionRuntime(),
      providers: await createCoreAuthProviders(projectRoot, loadedConfig),
      tokens: authStores.tokens,
      emailVerificationTokens: authStores.emailVerificationTokens,
      passwordResetTokens: authStores.passwordResetTokens,
      ...(notificationsModule && (mailModule || notificationsRuntimeBindings?.mailer)
        ? { delivery: createAuthNotificationsDeliveryHook(notificationsModule) }
        : mailModule
          ? { delivery: createAuthMailDeliveryHook(mailModule) }
          : {}),
      context: authContext,
    })
    const boundAuthRuntime = bindAuthRuntimeToContext(authModule.getAuthRuntime(), authContext)

    if (authorizationModule) {
      authorizationModule.authorizationInternals.configureAuthorizationAuthIntegration({
        hasGuard(guardName: string) {
          return guardName in loadedConfig.auth.guards
        },
        resolveDefaultActor: async () => boundAuthRuntime.user(),
        resolveGuardActor: async (guardName: string) => boundAuthRuntime.guard(guardName).user(),
      })
    }

    if (socialModule) {
      socialModule.configureSocialAuthRuntime({
        ...(await createCoreSocialBindings(projectRoot, loadedConfig, sessionModule)),
        encryptionKey: loadedConfig.auth.socialEncryptionKey,
      })
    }

    if (workosModule) {
      workosModule.configureWorkosAuthRuntime({
        identityStore: createCoreHostedIdentityStore('workos'),
      })
    }

    if (clerkModule) {
      clerkModule.configureClerkAuthRuntime({
        identityStore: createCoreHostedIdentityStore('clerk'),
      })
    }
  } else if (authorizationModule) {
    authorizationModule.authorizationInternals.resetAuthorizationAuthIntegration()
  }

  return Object.freeze({
    /* v8 ignore next -- only toggles shape when queue support is absent */
    ...(queueModule ? { queueModule } : {}),
    ...(sessionModule ? { session: sessionModule.getSessionRuntime() } : {}),
    ...(authModule && authConfigured ? { auth: authModule.getAuthRuntime() } : {}),
    ...(authModule && authConfigured ? { authContext } : {}),
  })
}

export async function resetOptionalHoloSubsystems(): Promise<void> {
  const projectRoot = getRuntimeState().current?.projectRoot ?? getRuntimeState().pendingProjectRoot
  await resetOptionalStorageRuntime()
  const queueModule = await loadQueueModule()
  await queueModule?.shutdownQueueRuntime()
  const mailModule = await loadMailModule()
  mailModule?.resetMailRuntime()
  const notificationsModule = await loadNotificationsModule()
  notificationsModule?.resetNotificationsRuntime()
  const broadcastModule = await loadBroadcastModule(false, projectRoot)
  broadcastModule?.resetBroadcastRuntime()
  const authModule = await loadAuthModule()
  authModule?.resetAuthRuntime()
  const authorizationModule = await loadAuthorizationModule()
  authorizationModule?.authorizationInternals.resetAuthorizationAuthIntegration()
  const socialModule = await loadSocialModule()
  socialModule?.resetSocialAuthRuntime()
  const workosModule = await loadWorkosModule()
  workosModule?.resetWorkosAuthRuntime()
  const clerkModule = await loadClerkModule()
  clerkModule?.resetClerkAuthRuntime()
  const sessionModule = await loadSessionModule()
  sessionModule?.resetSessionRuntime()
  const managedSessionRedisAdapters = getRuntimeState().sessionRedisAdapters
  if (managedSessionRedisAdapters) {
    await Promise.all(managedSessionRedisAdapters.map(adapter => adapter.close?.()))
    getRuntimeState().sessionRedisAdapters = undefined
  }
  const securityModule = await loadSecurityModule()
  const securityBindings = securityModule?.getSecurityRuntimeBindings()
  const state = getRuntimeState()
  const managedSecurityRedisAdapter = state.securityRateLimitStoreManaged === true
    ? state.securityRedisAdapter
    : undefined
  const managedSecurityRateLimitStore = state.securityRateLimitStoreManaged === true
    ? securityBindings?.rateLimitStore
    : undefined

  if (managedSecurityRedisAdapter) {
    await managedSecurityRedisAdapter.close?.()
    state.securityRedisAdapter = undefined
  }

  if (managedSecurityRateLimitStore) {
    await managedSecurityRateLimitStore.close?.()
  }

  state.securityRateLimitStoreManaged = undefined
  securityModule?.resetSecurityRuntime()
}

export async function createHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const loadedConfig = await loadConfigDirectory<TCustom>(projectRoot, {
    envName: options.envName,
    preferCache: options.preferCache,
    processEnv: options.processEnv,
  })
  const runtimeConfig: PortableRuntimeConfig<TCustom> = {
    db: loadedConfig.database,
    queue: loadedConfig.queue,
  }
  const manager = resolveRuntimeConnectionManagerOptions(runtimeConfig)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  const accessors = createConfigAccessors(loadedConfig.all)
  const runtimeOwnedQueueJobNames: string[] = []
  const runtimeOwnedEventNames: string[] = []
  const runtimeOwnedListenerIds: string[] = []
  const runtimeOwnedAuthorizationPolicyNames: string[] = []
  const runtimeOwnedAuthorizationAbilityNames: string[] = []
  let activeQueueModule: QueueModule | undefined
  let activeEventsModule: EventsModule | undefined
  let activeAuthorizationModule: AuthorizationModule | undefined
  let activeSessionRuntime: HoloSessionRuntimeBinding | undefined
  let activeAuthRuntime: HoloAuthRuntimeBinding | undefined
  let activeAuthContext: { activate(): void } | undefined
  let previousOptionalSubsystemBindings: OptionalSubsystemRuntimeBindings | undefined
  const previousRenderView = options.renderView
    ? getRuntimeState().renderView
    : undefined
  const fallbackQueueRuntime = Object.freeze({
    config: loadedConfig.queue,
    drivers: new Map<string, HoloQueueDriverBinding>(),
  }) as HoloQueueRuntimeBinding

  const runtime: MutableHoloRuntime<TCustom> = {
    projectRoot,
    loadedConfig,
    registry,
    manager,
    runtimeConfig,
    get queue() {
      return activeQueueModule?.getQueueRuntime() ?? fallbackQueueRuntime
    },
    get session() {
      return activeSessionRuntime
    },
    get auth() {
      return activeAuthRuntime && activeAuthContext
        ? bindAuthRuntimeToContext(activeAuthRuntime, activeAuthContext)
        : activeAuthRuntime
    },
    initialized: false,
    useConfig: accessors.useConfig,
    config: accessors.config,
    async initialize() {
      if (runtime.initialized) {
        throw new Error('Holo runtime is already initialized.')
      }

      if (getRuntimeState().current) {
        throw new Error('A Holo runtime is already initialized for this process.')
      }

      configureConfigRuntime(loadedConfig.all)
      configureDB(manager)
      previousOptionalSubsystemBindings = snapshotOptionalSubsystemRuntimeBindings()
      if (options.renderView) {
        configureHoloRenderingRuntime({
          renderView: options.renderView,
        })
      }

      try {
        await manager.initializeAll()

        const optionalSubsystems = await reconfigureOptionalHoloSubsystems(projectRoot, loadedConfig, {
          renderView: options.renderView,
        })
        activeQueueModule = optionalSubsystems.queueModule
        activeSessionRuntime = optionalSubsystems.session
        activeAuthRuntime = optionalSubsystems.auth
        activeAuthContext = optionalSubsystems.authContext
        /* v8 ignore start -- exercised only when optional packages are absent outside the monorepo test graph */
        const optionalEventsModule = activeQueueModule
          ? await loadEventsModule()
          : undefined
        if (activeQueueModule && optionalEventsModule) {
          await optionalEventsModule.ensureEventsQueueJobRegisteredAsync?.()
        }
        /* v8 ignore stop */

        if (registryHasEvents(registry)) {
          const eventsModule = await loadEventsModule(true)
          /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
          if (!eventsModule) {
            throw new Error('[@holo-js/core] Events support requires @holo-js/events to be installed.')
          }
          /* v8 ignore stop */
          activeEventsModule = eventsModule
          const eventRegistration = await registerProjectEventsAndListeners(
            projectRoot,
            registry,
            eventsModule,
            activeQueueModule,
          )
          runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length, ...eventRegistration.eventNames)
          runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length, ...eventRegistration.listenerIds)
        }

        activeAuthorizationModule = await loadAuthorizationModule()
        const authorizationRegistration = await registerProjectAuthorizationDefinitions(
          projectRoot,
          registry,
          activeAuthorizationModule,
        )
        runtimeOwnedAuthorizationPolicyNames.splice(0, runtimeOwnedAuthorizationPolicyNames.length, ...authorizationRegistration.policyNames)
        runtimeOwnedAuthorizationAbilityNames.splice(0, runtimeOwnedAuthorizationAbilityNames.length, ...authorizationRegistration.abilityNames)

        if (options.registerProjectQueueJobs === true && registryHasJobs(registry)) {
          /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
          if (!activeQueueModule) {
            throw new Error('[@holo-js/core] Project jobs require @holo-js/queue to be installed.')
          }
          /* v8 ignore stop */

          runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
          runtimeOwnedQueueJobNames.push(...await registerProjectQueueJobs(projectRoot, registry, activeQueueModule))
        }

        runtime.initialized = true
        getRuntimeState().current = runtime
      } catch (error) {
        unregisterProjectEventsAndListeners(activeEventsModule, runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectAuthorizationDefinitions(activeAuthorizationModule, runtimeOwnedAuthorizationPolicyNames, runtimeOwnedAuthorizationAbilityNames)
        runtimeOwnedAuthorizationPolicyNames.splice(0, runtimeOwnedAuthorizationPolicyNames.length)
        runtimeOwnedAuthorizationAbilityNames.splice(0, runtimeOwnedAuthorizationAbilityNames.length)
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeAuthorizationModule = undefined
        activeEventsModule = undefined
        activeQueueModule = undefined
        activeSessionRuntime = undefined
        activeAuthRuntime = undefined
        activeAuthContext = undefined
        await manager.disconnectAll().catch(() => {})
        resetDB()
        await resetOptionalHoloSubsystems()
        if (previousOptionalSubsystemBindings) {
          restoreOptionalSubsystemRuntimeBindings(previousOptionalSubsystemBindings)
        }
        if (options.renderView) {
          restoreHoloRenderingRuntime(previousRenderView)
        }
        resetConfigRuntime()
        getRuntimeState().current = undefined
        throw error
      }
    },
    async shutdown() {
      try {
        if (runtime.initialized) {
          await manager.disconnectAll()
        }
      } finally {
        runtime.initialized = false
        if (getRuntimeState().current === runtime) {
          getRuntimeState().current = undefined
        }
        unregisterProjectEventsAndListeners(activeEventsModule, runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectAuthorizationDefinitions(activeAuthorizationModule, runtimeOwnedAuthorizationPolicyNames, runtimeOwnedAuthorizationAbilityNames)
        runtimeOwnedAuthorizationPolicyNames.splice(0, runtimeOwnedAuthorizationPolicyNames.length)
        runtimeOwnedAuthorizationAbilityNames.splice(0, runtimeOwnedAuthorizationAbilityNames.length)
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeAuthorizationModule = undefined
        activeEventsModule = undefined
        activeQueueModule = undefined
        activeSessionRuntime = undefined
        activeAuthRuntime = undefined
        activeAuthContext = undefined
        resetDB()
        await resetOptionalHoloSubsystems()
        if (previousOptionalSubsystemBindings) {
          restoreOptionalSubsystemRuntimeBindings(previousOptionalSubsystemBindings)
        }
        if (options.renderView) {
          restoreHoloRenderingRuntime(previousRenderView)
        }
        resetConfigRuntime()
      }
    },
  }

  return runtime
}

export async function initializeHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const state = getRuntimeState()
  const resolvedProjectRoot = resolve(projectRoot)
  const current = state.current as HoloRuntime<TCustom> | undefined

  if (current) {
    if (resolve(current.projectRoot) !== resolvedProjectRoot) {
      throw new Error(`A Holo runtime is already initialized for "${current.projectRoot}".`)
    }

    return current
  }

  if (state.pending) {
    if (state.pendingProjectRoot && resolve(state.pendingProjectRoot) !== resolvedProjectRoot) {
      throw new Error(`A Holo runtime is already initializing for "${state.pendingProjectRoot}".`)
    }

    return state.pending as Promise<HoloRuntime<TCustom>>
  }

  const pending = (async () => {
    const runtime = await createHolo<TCustom>(projectRoot, options)
    await runtime.initialize()
    return runtime
  })()

  state.pending = pending as Promise<HoloRuntime>
  state.pendingProjectRoot = resolvedProjectRoot

  try {
    return await pending
  } finally {
    if (state.pending === pending) {
      state.pending = undefined
      state.pendingProjectRoot = undefined
    }
  }
}

export function peekHolo<TCustom extends HoloConfigMap = HoloConfigMap>(): HoloRuntime<TCustom> | undefined {
  return getRuntimeState().current as HoloRuntime<TCustom> | undefined
}

export async function ensureHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const current = peekHolo<TCustom>()
  if (!current) {
    return initializeHolo<TCustom>(projectRoot, options)
  }

  if (resolve(current.projectRoot) !== resolve(projectRoot)) {
    throw new Error(`A Holo runtime is already initialized for "${current.projectRoot}".`)
  }

  return current
}

export function getHolo<TCustom extends HoloConfigMap = HoloConfigMap>(): HoloRuntime<TCustom> {
  const current = getRuntimeState().current as HoloRuntime<TCustom> | undefined
  if (!current) {
    throw new Error('Holo runtime is not initialized.')
  }

  return current
}

export async function resetHoloRuntime(): Promise<void> {
  const current = getRuntimeState().current
  const projectRoot = current?.projectRoot ?? getRuntimeState().pendingProjectRoot
  getRuntimeState().pending = undefined
  getRuntimeState().pendingProjectRoot = undefined
  if (!current) {
    resetDB()
    await resetOptionalHoloSubsystems()
    resetHoloRenderingRuntime()
    resetConfigRuntime()
    return
  }

  await current.shutdown()
  const mailModule = await loadMailModule()
  mailModule?.resetMailRuntime()
  const notificationsModule = await loadNotificationsModule()
  notificationsModule?.resetNotificationsRuntime()
  const securityModule = await loadSecurityModule()
  securityModule?.resetSecurityRuntime()
  const broadcastModule = await loadBroadcastModule(false, projectRoot)
  broadcastModule?.resetBroadcastRuntime()
  resetHoloRenderingRuntime()
}

function getConfigValue(path: string): unknown {
  return globalConfig(path as never)
}

function getConfigSection(key: string): unknown {
  return globalUseConfig(key as never)
}

export const holoRuntimeInternals = {
  createAuthMailDeliveryHook,
  createAuthNotificationsDeliveryHook,
  createCoreNotificationBroadcaster,
  createCoreNotificationMailSender,
  bindAuthRuntimeToContext,
  createCoreAuthProviders,
  createCoreAuthStores,
  createCoreHostedIdentityStore,
  createCoreNotificationStore,
  createNotificationMailText,
  createCoreSessionStores,
  registerProjectAuthorizationDefinitions,
  unregisterProjectAuthorizationDefinitions,
  resolveAuthorizationDefinitionExport,
  fromHostedIdentityProviderValue: fromHostedIdentityProviderValue,
  getConfigSection,
  getConfigValue,
  createCoreSocialBindings,
  normalizeNotificationRecordFromRow,
  loadConfiguredSocialProviders,
  loadAuthorizationModule,
  markProviderUser,
  normalizeDateValue,
  normalizeEmailVerificationTokenRecord,
  normalizeJsonValue,
  normalizePasswordResetTokenRecord,
  serializeNotificationRecordForRow,
  moduleInternals: portableRuntimeModuleInternals,
}
