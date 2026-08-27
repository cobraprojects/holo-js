import { existsSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { resolve } from 'node:path'
import type { AuthFacade, AuthHostedIdentityStore, AuthLogoutResult, AuthMultiFactorVerificationState } from '@holo-js/auth'
import type {} from '@holo-js/auth/config'
import type {} from '@holo-js/broadcast/config'
import type {} from '@holo-js/cache/config'
import type {} from '@holo-js/mail/config'
import type {} from '@holo-js/notifications/config'
import type {} from '@holo-js/queue/config'
import type {} from '@holo-js/security/config'
import type {} from '@holo-js/session/config'
import type {} from '@holo-js/storage/config'
import { createRuntimeLifecycle } from '@holo-js/kernel'
import {
  config as globalConfig,
  configureConfigRuntime,
  createConfigAccessors,
  loadConfigDirectory,
  resetConfigRuntime,
  useConfig as globalUseConfig,
  type DotPath,
  type HoloConfigValues,
  type LoadedHoloConfig,
  type HoloConfigMap,
  type ValueAtPath,
} from '@holo-js/config'
import {
  connectionAsyncContext,
  configureDB,
  DB,
  Entity,
  TableQueryBuilder,
  registerDatabaseDriverFactory,
  resetDB,
  unregisterDatabaseDriverFactory,
  type DatabaseDriverFactory,
} from '@holo-js/db'
import { importBundledRuntimeModule, importOptionalRuntimeModule } from '../runtimeModule'
import { resolveRuntimeConnectionManagerOptions } from './dbRuntime'
import { loadGeneratedProjectRegistry, type GeneratedProjectRegistry } from './registry'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../storageRuntime'
import { preloadDiscoveredModelModules, preloadGeneratedSchemaModule } from './discoveryRuntime'
import { loadInstalledFeatureConfigContributions } from './configRuntime'
import {
  configureHoloRenderingRuntime,
  getHoloRenderingRuntime,
  resetHoloRenderingRuntime,
  restoreHoloRenderingRuntime,
  type HoloServerViewRenderer,
} from './renderingRuntime'
export type { HoloServerViewRenderInput, HoloServerViewRenderer } from './renderingRuntime'
export { configureHoloRenderingRuntime, resetHoloRenderingRuntime }
import {
  normalizeAccessTokenRecord,
  normalizeDateValue,
  normalizeEmailVerificationTokenRecord,
  normalizeJsonValue,
  normalizeMultiFactorCredentialRecord,
  normalizePasswordResetTokenRecord,
  normalizeStoredUserId,
  serializeAccessTokenRecord,
  serializeEmailVerificationTokenRecord,
  serializeMultiFactorCredentialRecord,
  serializePasswordResetTokenRecord,
} from './authPersistence'
import {
  bootConfiguredHoloPluginModule,
  loadConfiguredHoloPluginBootModules,
  loadConfiguredHoloPluginDefinitions,
  mergeQueueRuntimeDriverFactories,
  resolveLoadedPluginNames,
  resetBootedHoloPluginModules,
  type CoreCachePluginDriverRegistry,
  type CoreQueueDriverFactory,
} from './pluginRuntime'
import { createRequestAwareAuthContext } from './authRequestContext'
import {
  normalizeNotificationRecordFromRow,
  serializeNotificationRecordForRow,
} from './recordPersistence'
import { createCoreNotificationStore } from './notificationPersistence'
import { createCoreDatabaseSessionAdapter } from './sessionPersistence'
import {
  createAuthActionUrl,
  createAuthEmailHtml,
  createAuthMailDeliveryHook,
  createCoreNotificationMailSender,
  createNotificationMailText,
  formatAuthEmailExpiration,
} from './authMailDelivery'
import { createOptionalFeatureModuleLoader } from './optionalFeatureLoader'
import {
  authConfigUsesClerkProviders,
  authConfigUsesSocialProviders,
  authConfigUsesWorkosProviders,
  hasLoadedConfigFile,
  queueConfigUsesDatabaseBackedFailedStore,
  queueConfigUsesDatabaseDriver,
  queueConfigUsesRedisDriver,
  registryHasEvents,
  registryHasJobs,
} from './featureDetection'
import {
  createRuntimeStateAccessors,
  type OptionalSubsystemRuntimeBindings,
} from './runtimeState'

type RuntimeConfigRegistry<TCustom extends HoloConfigMap> = HoloConfigValues<TCustom>
type PortableRuntimeConfig<TCustom extends HoloConfigMap> = {
  readonly db: LoadedHoloConfig<TCustom>['database']
  readonly queue: LoadedHoloConfig<TCustom>['queue']
}

type CoreHostedIdentityRecord = {
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

type CoreHostedIdentityStore = AuthHostedIdentityStore & {
  claim(record: CoreHostedIdentityRecord): Promise<CoreHostedIdentityRecord>
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
  flash(sessionId: string, key: string, value: unknown, options?: { readonly store?: string }): Promise<void>
  take<TValue = unknown>(sessionId: string, key: string, options?: { readonly store?: string }): Promise<TValue | undefined>
  cookie(name: string, value: string, options?: Record<string, unknown>): string
  sessionCookie(value: string, options?: Record<string, unknown>): string
  rememberMeCookie(value: string, options?: Record<string, unknown>): string
}

export interface HoloAuthRuntimeBinding extends AuthFacade {
  logoutAll(guardName?: string): Promise<readonly AuthLogoutResult[]>
}

interface HoloAuthAuthorizationTargetConstructor<TInstance = object> {
  readonly prototype: TInstance
}

interface HoloAuthAuthorizationTargetModelDefinition {
  readonly name: string
  readonly table?: {
    readonly tableName?: string
  }
}

interface HoloAuthAuthorizationTargetModel<TInstance extends object = object> {
  readonly definition: HoloAuthAuthorizationTargetModelDefinition
  query(): {
    first(): Promise<TInstance | undefined>
    firstOrFail(): Promise<TInstance>
  }
}

type HoloAuthAuthorizationSubject = object
  | HoloAuthAuthorizationTargetConstructor
  | HoloAuthAuthorizationTargetModel

export interface HoloQueueRuntimeBinding {
  readonly config: LoadedHoloConfig['queue']
  readonly drivers: ReadonlyMap<string, HoloQueueDriverBinding>
}

export interface HoloQueueDriverBinding {
  readonly name: string
  readonly driver: string
  readonly mode: 'async' | 'sync'
}

type QueueModule = {
  configureQueueRuntime(options: { config: LoadedHoloConfig['queue'], redisConfig?: LoadedHoloConfig['redis'] } & Record<string, unknown>): void
  loadQueuePluginDriverFactories(projectRoot?: string, pluginNames?: readonly string[]): Promise<readonly CoreQueueDriverFactory[]>
  loadQueuePluginDrivers?(projectRoot?: string, pluginNames?: readonly string[]): Promise<void>
  getRegisteredQueueJob(name: string): { sourcePath?: string } | undefined
  getQueueRuntime(): HoloQueueRuntimeBinding
  isQueueJobDefinition(value: unknown): boolean
  normalizeQueueJobDefinition(value: unknown): NormalizedQueueJobDefinition
  registerQueueJob(
    definition: NormalizedQueueJobDefinition,
    options: { name: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  shutdownQueueRuntime(): Promise<void>
  resetQueueRuntime?(): void
  unregisterQueueJob(name: string): void
}

type QueueDbModule = {
  createQueueDbRuntimeOptions(): Record<string, unknown> & {
    readonly driverFactories?: readonly CoreQueueDriverFactory[]
  }
}

type QueueRedisModule = {
  readonly redisQueueDriverFactory: CoreQueueDriverFactory
}

type CacheModule = {
  configureCacheRuntime(options?: {
    readonly config: LoadedHoloConfig['cache']
    readonly databaseConfig?: LoadedHoloConfig['database']
    readonly redisConfig?: LoadedHoloConfig['redis']
    readonly drivers?: CoreCachePluginDriverRegistry
  }): void
  loadConfiguredCachePluginDriverContracts(
    projectRoot: string,
    pluginNames: readonly string[],
    configs: readonly (Readonly<Record<string, unknown>> & { readonly name: string, readonly driver: string })[],
  ): Promise<readonly (Readonly<Record<string, unknown>> & { readonly name: string })[]>
  loadCachePluginDrivers?(projectRoot?: string): Promise<void>
  resetCacheRuntime(): void
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

type CoreSessionStoreBinding = {
  read(sessionId: string): Promise<unknown | null>
  write(record: unknown): Promise<void>
  delete(sessionId: string): Promise<void>
  rotate?(previousSessionId: string, record: unknown): Promise<void>
  flash?(sessionId: string, key: string, value: unknown): Promise<void>
  take?(sessionId: string, key: string): Promise<{ readonly found: boolean, readonly value?: unknown }>
}

type SessionModule = {
  configureSessionRuntime(options?: {
    readonly config: LoadedHoloConfig['session']
    readonly stores: Readonly<Record<string, CoreSessionStoreBinding>>
  }): void
  createDatabaseSessionStore(adapter: CoreSessionStoreBinding): CoreSessionStoreBinding
  createFileSessionStore(root: string): CoreSessionStoreBinding
  createRedisSessionStore(adapter: SessionRedisAdapter): CoreSessionStoreBinding
  getSessionRuntime(): HoloSessionRuntimeBinding
  resetSessionRuntime(): void
}

type SecurityModule = {
  configureSecurityRuntime(options?: {
    readonly config: LoadedHoloConfig['security']
    readonly cors?: LoadedHoloConfig['cors']
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
  /* v8 ignore next -- helper branch depends on whether the adapter exposes disconnect, close, or both */
  return adapter.disconnect?.() || adapter.close?.()
}

type NotificationQuery = {
  readonly id?: string
  readonly recipient: { readonly id: string | number, readonly type: string }
  readonly type?: string
  readonly dataMatches?: readonly {
    readonly path: readonly string[]
    readonly value: string | number | boolean | null
  }[]
}

type NotificationPagination = {
  readonly limit: number
  readonly offset: number
}

type NotificationPage = {
  readonly records: readonly unknown[]
  readonly limit: number
  readonly offset: number
  readonly total: number
  readonly unread: number
}

type NotificationsModule = {
  configureNotificationsRuntime(options?: {
    readonly config: LoadedHoloConfig['notifications']
    readonly deferAfterCommit?: (callback: () => Promise<void>) => boolean
    readonly projectRoot?: string
    readonly plugins?: readonly string[]
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
      list(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
      unread(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
      markAsRead(query: NotificationQuery, ids: readonly string[]): Promise<number>
      markAsUnread(query: NotificationQuery, ids: readonly string[]): Promise<number>
      delete(query: NotificationQuery, ids: readonly string[]): Promise<number>
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
      list(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
      unread(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
      markAsRead(query: NotificationQuery, ids: readonly string[]): Promise<number>
      markAsUnread(query: NotificationQuery, ids: readonly string[]): Promise<number>
      delete(query: NotificationQuery, ids: readonly string[]): Promise<number>
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

type AuthEmailVerificationNotification = {
  readonly email: string
  readonly name?: string
  readonly url: string
  readonly expiresAt: Date
}

type AuthPasswordResetNotification = {
  readonly email: string
  readonly url: string
  readonly expiresAt: Date
}

type AuthNotificationModule = {
  readonly default?: unknown
  readonly notification?: unknown
  readonly emailVerificationNotification?: unknown
  readonly passwordResetNotification?: unknown
}

type BroadcastModule = {
  configureBroadcastRuntime(options?: {
    readonly config: LoadedHoloConfig['broadcast']
    readonly projectRoot?: string
    readonly plugins?: readonly string[]
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
    readonly projectRoot?: string
    readonly plugins?: readonly string[]
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
    readonly multiFactor?: {
      find(provider: string, userId: string | number): Promise<unknown | null>
      save(record: unknown): Promise<void>
      delete(provider: string, userId: string | number): Promise<void>
      advanceCounter(provider: string, userId: string | number, counter: number): Promise<AuthMultiFactorVerificationState | null>
      consumeRecoveryCode(provider: string, userId: string | number, recoveryCodeHash: string): Promise<AuthMultiFactorVerificationState | null>
      replaceRecoveryCodes(provider: string, userId: string | number, recoveryCodeHashes: readonly string[], updatedAt: Date, verification: AuthMultiFactorVerificationState): Promise<boolean>
    }
    readonly multiFactorEncryptionKey?: string
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
      getRequestCookie?(name: string): string | undefined | Promise<string | undefined>
      getRequestHeader?(name: string): string | undefined | Promise<string | undefined>
      getAccessToken?(guardName: string): string | undefined
      setAccessToken?(guardName: string, token?: string): void
      getRememberToken?(guardName: string): string | undefined
      setRememberToken?(guardName: string, token?: string): void
    }
    readonly authorization?: {
      can(
        user: object,
        action: string,
        target: HoloAuthAuthorizationSubject,
      ): boolean | Promise<boolean>
    }
  }): void
  createAsyncAuthContext(): {
    activate(): void
    getSessionId(guardName: string): string | undefined
    setSessionId(guardName: string, sessionId?: string): void
    getCachedUser(guardName: string): unknown
    setCachedUser(guardName: string, user: unknown): void
    getRequestCookie?(name: string): string | undefined | Promise<string | undefined>
    getRequestHeader?(name: string): string | undefined | Promise<string | undefined>
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
  forUser(actor: object | null): {
    can(action: string, target: HoloAuthAuthorizationSubject): Promise<boolean>
  }
  authorizationInternals: {
    getAuthorizationRuntimeState(): {
      policiesByName: Map<string, unknown>
      abilitiesByName: Map<string, unknown>
    }
    getAuthorizationAuthIntegration(): {
      hasGuard(guardName: string): boolean
      resolveDefaultActor(): Promise<object | null> | object | null
      resolveGuardActor(guardName: string): Promise<object | null> | object | null
      createError?(decision: { readonly message?: string, readonly status: 200 | 403 | 404 }): Error
    }
    registerPolicyDefinition?(definition: unknown): unknown
    registerAbilityDefinition?(definition: unknown): unknown
    configureAuthorizationAuthIntegration(options?: {
      hasGuard(guardName: string): boolean
      resolveDefaultActor(): Promise<object | null> | object | null
      resolveGuardActor(guardName: string): Promise<object | null> | object | null
      createError?(decision: { readonly message?: string, readonly status: 200 | 403 | 404 }): Error
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
        readonly browserBinding?: string
        readonly createdAt: Date
      }): Promise<void>
      read(provider: string, state: string): Promise<{
        readonly provider: string
        readonly state: string
        readonly codeVerifier: string
        readonly guard: string
        readonly browserBinding?: string
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
    readonly identityStore?: AuthHostedIdentityStore
  }): void
  resetWorkosAuthRuntime(): void
}

type ClerkModule = {
  configureClerkAuthRuntime(options?: {
    readonly providers?: Readonly<Record<string, HostedAuthVerifierRuntime>>
    readonly identityStore?: AuthHostedIdentityStore
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
  readonly authRequest?: {
    readonly getCookie?: (name: string) => string | undefined | Promise<string | undefined>
    readonly getHeader?: (name: string) => string | undefined | Promise<string | undefined>
    readonly appendResponseCookie?: (cookie: string) => void | Promise<void>
    readonly redirectResponse?: (url: string, status?: 301 | 302 | 303 | 307 | 308) => void | Promise<void>
  }
  readonly authorizationError?: {
    readonly createError?: (decision: { readonly message?: string, readonly status: 200 | 403 | 404 }) => Error
  }
}

type HoloRuntimeReconfigureOptions = Pick<
  CreateHoloOptions,
  'authRequest' | 'authorizationError' | 'renderView'
>

const reconfigureRuntime = Symbol('holo.runtime.reconfigure')

const frameworkBuildEnvKey = 'HOLO_INTERNAL_FRAMEWORK_BUILD'

function shouldBootRuntimeServices(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  return processEnv[frameworkBuildEnvKey] !== '1'
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
  runWithAuthRequestAccessors<TValue>(
    accessors: NonNullable<CreateHoloOptions['authRequest']>,
    callback: () => TValue,
  ): TValue
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

const {
  getRuntimeState,
  restoreOptionalSubsystemRuntimeBindings,
  snapshotOptionalSubsystemRuntimeBindings,
} = createRuntimeStateAccessors<HoloRuntime, SecurityRedisAdapter, SessionRedisAdapter>()

const BROADCAST_PUBLISH_TIMEOUT_MS = 10_000

async function importOptionalModule<TModule>(
  specifier: string,
  options: {
    readonly projectRoot?: string
  } = {},
): Promise<TModule | undefined> {
  return importOptionalRuntimeModule<TModule>(specifier, options)
}

const portableRuntimeModuleInternals = {
  importOptionalModule,
}

const HOLO_AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

const importOptionalFeature = <TModule>(
  specifier: string,
  options?: { readonly projectRoot?: string },
): Promise<TModule | undefined> => portableRuntimeModuleInternals.importOptionalModule<TModule>(specifier, options)

const loadQueueModule = createOptionalFeatureModuleLoader<QueueModule>(
  importOptionalFeature,
  '@holo-js/queue',
  '[@holo-js/core] Queue support requires @holo-js/queue to be installed.',
)

async function loadConfiguredDatabaseDrivers<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
): Promise<readonly DatabaseDriverFactory[]> {
  const packageByDriver = {
    sqlite: { packageName: '@holo-js/db-sqlite', factoryExport: 'sqliteDatabaseDriverFactory' },
    postgres: { packageName: '@holo-js/db-postgres', factoryExport: 'postgresDatabaseDriverFactory' },
    mysql: { packageName: '@holo-js/db-mysql', factoryExport: 'mysqlDatabaseDriverFactory' },
  } as const
  const drivers = new Set(Object.values(loadedConfig.database.connections).map((connection) => {
    if (typeof connection === 'string') {
      if (connection.startsWith('postgres://') || connection.startsWith('postgresql://')) return 'postgres'
      if (connection.startsWith('mysql://') || connection.startsWith('mysql2://')) return 'mysql'
      return 'sqlite'
    }
    return connection.driver ?? 'sqlite'
  }))
  const factories: DatabaseDriverFactory[] = []
  for (const driver of drivers) {
    const contribution = packageByDriver[driver]
    const { packageName, factoryExport } = contribution
    const module = await portableRuntimeModuleInternals.importOptionalModule<Record<string, unknown>>(packageName, { projectRoot })
    if (!module) throw new Error(`[@holo-js/core] Database driver "${driver}" requires ${packageName} to be installed.`)
    const factory = module[factoryExport] as DatabaseDriverFactory | undefined
    if (!factory) throw new Error(`[@holo-js/core] Database driver package ${packageName} does not export ${factoryExport}.`)
    factories.push(factory)
  }
  return factories
}

async function loadQueueDbModule(projectRoot: string): Promise<QueueDbModule | undefined> {
  return createOptionalFeatureModuleLoader<QueueDbModule>(
    importOptionalFeature,
    '@holo-js/queue-db',
    '[@holo-js/core] Database queues require @holo-js/queue-db to be installed.',
  )(false, { projectRoot })
}

async function loadQueueRedisModule(projectRoot: string): Promise<QueueRedisModule | undefined> {
  return createOptionalFeatureModuleLoader<QueueRedisModule>(
    importOptionalFeature,
    '@holo-js/queue-redis',
    '[@holo-js/core] Redis queues require @holo-js/queue-redis to be installed.',
  )(false, { projectRoot })
}

async function loadCacheModule(required = false, projectRoot?: string): Promise<CacheModule | undefined> {
  const loader = createOptionalFeatureModuleLoader<CacheModule>(
    importOptionalFeature,
    '@holo-js/cache',
    '[@holo-js/core] Cache support requires @holo-js/cache to be installed.',
  )
  return required ? loader(true, { projectRoot }) : loader(false, { projectRoot })
}

async function loadConfiguredCacheDrivers(
  projectRoot: string,
  cacheConfig: NonNullable<LoadedHoloConfig['cache']>,
): Promise<void> {
  const packageByDriver = {
    database: '@holo-js/cache-db',
    redis: '@holo-js/cache-redis',
  } as const
  const drivers = new Set(Object.values(cacheConfig.drivers).map(driver => driver.driver))
  for (const driver of drivers) {
    if (driver !== 'database' && driver !== 'redis') continue
    const packageName = packageByDriver[driver]
    const module = await portableRuntimeModuleInternals.importOptionalModule(packageName, { projectRoot })
    if (!module) throw new Error(`[@holo-js/core] Cache driver "${driver}" requires ${packageName} to be installed.`)
  }
}

function resetCacheRuntimeGlobalsFallback(): void {
  const runtime = globalThis as typeof globalThis & {
    __holoCacheRuntime__?: {
      bindings?: unknown
    }
    __holoCacheQueryBridge__?: {
      dependencyIndex?: unknown
    }
    __holoDbQueryCacheBridge__?: {
      bridge?: unknown
    }
  }

  if (runtime.__holoCacheRuntime__) {
    runtime.__holoCacheRuntime__.bindings = undefined
  }

  if (runtime.__holoCacheQueryBridge__) {
    runtime.__holoCacheQueryBridge__.dependencyIndex = undefined
  }

  if (runtime.__holoDbQueryCacheBridge__) {
    runtime.__holoDbQueryCacheBridge__.bridge = undefined
  }
}

const loadEventsModule = createOptionalFeatureModuleLoader<EventsModule>(
  importOptionalFeature,
  '@holo-js/events',
  '[@holo-js/core] Events support requires @holo-js/events to be installed.',
)
const loadSessionModule = createOptionalFeatureModuleLoader<SessionModule>(
  importOptionalFeature,
  '@holo-js/session',
  '[@holo-js/core] Session support requires @holo-js/session to be installed.',
)
const loadSecurityModule = createOptionalFeatureModuleLoader<SecurityModule>(
  importOptionalFeature,
  '@holo-js/security',
  '[@holo-js/core] Security support requires @holo-js/security to be installed.',
)
const loadSecurityRedisAdapterModule = createOptionalFeatureModuleLoader<SecurityRedisAdapterModule>(
  importOptionalFeature,
  '@holo-js/security/drivers/redis-adapter',
  '[@holo-js/core] Redis-backed security rate limits require @holo-js/security/drivers/redis-adapter to be installed.',
)
const loadSessionRedisAdapterModule = createOptionalFeatureModuleLoader<SessionRedisAdapterModule>(
  importOptionalFeature,
  '@holo-js/session/drivers/redis-adapter',
  '[@holo-js/core] Redis-backed session stores require @holo-js/session/drivers/redis-adapter to be installed.',
)
const loadNotificationsModule = createOptionalFeatureModuleLoader<NotificationsModule>(
  importOptionalFeature,
  '@holo-js/notifications',
  '[@holo-js/core] Notifications support requires @holo-js/notifications to be installed.',
)

async function loadBroadcastModule(required = false, projectRoot?: string): Promise<BroadcastModule | undefined> {
  const loader = createOptionalFeatureModuleLoader<BroadcastModule>(
    importOptionalFeature,
    '@holo-js/broadcast',
    '[@holo-js/core] Broadcast support requires @holo-js/broadcast to be installed.',
  )
  return required ? loader(true, { projectRoot }) : loader(false, { projectRoot })
}

const loadMailModule = createOptionalFeatureModuleLoader<MailModule>(
  importOptionalFeature,
  '@holo-js/mail',
  '[@holo-js/core] Mail support requires @holo-js/mail to be installed.',
)
const loadAuthModule = createOptionalFeatureModuleLoader<AuthModule>(
  importOptionalFeature,
  '@holo-js/auth',
  '[@holo-js/core] Auth support requires @holo-js/auth to be installed.',
)
const loadAuthorizationModule = createOptionalFeatureModuleLoader<AuthorizationModule>(
  importOptionalFeature,
  '@holo-js/authorization',
  '[@holo-js/core] Authorization support requires @holo-js/authorization to be installed.',
)
const loadSocialModule = createOptionalFeatureModuleLoader<SocialModule>(
  importOptionalFeature,
  '@holo-js/auth-social',
  '[@holo-js/core] Social auth config requires @holo-js/auth-social to be installed.',
)
const loadWorkosModule = createOptionalFeatureModuleLoader<WorkosModule>(
  importOptionalFeature,
  '@holo-js/auth-workos',
  '[@holo-js/core] WorkOS auth config requires @holo-js/auth-workos to be installed.',
)
const loadClerkModule = createOptionalFeatureModuleLoader<ClerkModule>(
  importOptionalFeature,
  '@holo-js/auth-clerk',
  '[@holo-js/core] Clerk auth config requires @holo-js/auth-clerk to be installed.',
)

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
  return value !== null && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return value !== null && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
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
  readonly stores: Readonly<Record<string, CoreSessionStoreBinding>>
  readonly redisAdapters: readonly SessionRedisAdapter[]
}> {
  const stores: Record<string, CoreSessionStoreBinding> = {}
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
      stores[name] = sessionModule.createDatabaseSessionStore(createCoreDatabaseSessionAdapter(config.table, connectionName))
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

const AUTH_EMAIL_VERIFICATION_NOTIFICATION_PATHS = [
  'server/notifications/auth/email-verification.ts',
  'server/notifications/auth/email-verification.mts',
  'server/notifications/auth/email-verification.js',
  'server/notifications/auth/email-verification.mjs',
  'server/notifications/auth/email-verification.cts',
  'server/notifications/auth/email-verification.cjs',
] as const

const AUTH_PASSWORD_RESET_NOTIFICATION_PATHS = [
  'server/notifications/auth/password-reset.ts',
  'server/notifications/auth/password-reset.mts',
  'server/notifications/auth/password-reset.js',
  'server/notifications/auth/password-reset.mjs',
  'server/notifications/auth/password-reset.cts',
  'server/notifications/auth/password-reset.cjs',
] as const

function resolveExistingProjectFile(projectRoot: string | undefined, candidates: readonly string[]): string | undefined {
  if (!projectRoot) {
    return undefined
  }

  return candidates.find(candidate => existsSync(resolve(projectRoot, candidate)))
}

function resolveAuthNotification(
  module: AuthNotificationModule,
  exportName: 'emailVerificationNotification' | 'passwordResetNotification',
  filePath: string,
): unknown {
  const notification = module[exportName] ?? module.notification ?? module.default
  if (!isAuthNotificationDefinition(notification)) {
    throw new Error(
      `[@holo-js/core] Auth notification file "${filePath}" must export a notification definition.`,
    )
  }

  return notification
}

function isAuthNotificationDefinition(notification: unknown): notification is {
  readonly via: (...args: readonly unknown[]) => readonly string[]
  readonly build: Readonly<Record<string, (...args: readonly unknown[]) => unknown>>
} {
  if (!notification || typeof notification !== 'object') {
    return false
  }

  const candidate = notification as {
    readonly via?: unknown
    readonly build?: unknown
  }
  if (typeof candidate.via !== 'function' || !candidate.build || typeof candidate.build !== 'object') {
    return false
  }

  return Object.values(candidate.build).some(factory => typeof factory === 'function')
}

async function loadProjectAuthNotification(
  projectRoot: string | undefined,
  candidates: readonly string[],
  exportName: 'emailVerificationNotification' | 'passwordResetNotification',
): Promise<unknown | undefined> {
  const filePath = resolveExistingProjectFile(projectRoot, candidates)
  if (!filePath) {
    return undefined
  }

  const module = await importRuntimeModule(projectRoot!, filePath) as AuthNotificationModule
  return resolveAuthNotification(module, exportName, filePath)
}

function createAuthNotificationsDeliveryHook(
  notificationsModule: NotificationsModule,
  appUrl: string,
  projectRoot?: string,
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
    readonly route: string
  }): Promise<void>
  sendPasswordReset(input: {
    readonly broker: string
    readonly provider: string
    readonly email: string
    readonly token: {
      readonly id: string
      readonly plainTextToken: string
      readonly expiresAt: Date
    }
    readonly route: string
  }): Promise<void>
} {
  return Object.freeze({
    async sendEmailVerification(input): Promise<void> {
      const recipientName = typeof (input.user as { name?: unknown })?.name === 'string'
        ? (input.user as { name?: string }).name?.trim()
        : undefined
      const actionUrl = createAuthActionUrl(appUrl, input.route, input.token.plainTextToken)
      const authNotification: AuthEmailVerificationNotification = Object.freeze({
        email: input.email,
        ...(recipientName ? { name: recipientName } : {}),
        url: actionUrl,
        expiresAt: input.token.expiresAt,
      })
      const projectNotification = await loadProjectAuthNotification(
        projectRoot,
        AUTH_EMAIL_VERIFICATION_NOTIFICATION_PATHS,
        'emailVerificationNotification',
      )
      const lines = [
        'Confirm your account to finish signing in.',
        `This verification link expires at ${formatAuthEmailExpiration(input.token.expiresAt)}.`,
      ] as const
      const action = {
        label: 'Verify email address',
        url: actionUrl,
      } as const
      const notification = projectNotification ?? notificationsModule.defineNotification({
        type: 'auth.email-verification',
        via() {
          return ['email']
        },
        build: {
          email() {
            return {
              subject: 'Verify your email address',
              ...(recipientName ? { greeting: `Hello ${recipientName},` } : {}),
              lines,
              action,
              html: createAuthEmailHtml({
                subject: 'Verify your email address',
                ...(recipientName ? { greeting: `Hello ${recipientName},` } : {}),
                lines,
                action,
              }),
              metadata: {
                provider: input.provider,
                tokenId: input.token.id,
              },
            }
          },
        },
      })

      await notificationsModule
        .notify(authNotification, notification)
    },
    async sendPasswordReset(input): Promise<void> {
      const actionUrl = createAuthActionUrl(appUrl, input.route, input.token.plainTextToken)
      const authNotification: AuthPasswordResetNotification = Object.freeze({
        email: input.email,
        url: actionUrl,
        expiresAt: input.token.expiresAt,
      })
      const projectNotification = await loadProjectAuthNotification(
        projectRoot,
        AUTH_PASSWORD_RESET_NOTIFICATION_PATHS,
        'passwordResetNotification',
      )
      const lines = [
        'Click the link below to choose a new password.',
        `This reset link expires at ${formatAuthEmailExpiration(input.token.expiresAt)}.`,
      ] as const
      const action = {
        label: 'Reset password',
        url: actionUrl,
      } as const
      const notification = projectNotification ?? notificationsModule.defineNotification({
        type: 'auth.password-reset',
        via() {
          return ['email']
        },
        build: {
          email() {
            return {
              subject: 'Reset your password',
              lines,
              action,
              html: createAuthEmailHtml({
                subject: 'Reset your password',
                lines,
                action,
              }),
              metadata: {
                provider: input.provider,
                tokenId: input.token.id,
              },
            }
          },
        },
      })

      await notificationsModule
        .notify(authNotification, notification)
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

async function loadConfiguredSocialProviders<TCustom extends HoloConfigMap>(
  projectRootOrLoadedConfig: string | LoadedHoloConfig<TCustom>,
  maybeLoadedConfig?: LoadedHoloConfig<TCustom>,
): Promise<Readonly<Record<string, unknown>>> {
  const projectRoot = typeof projectRootOrLoadedConfig === 'string'
    ? projectRootOrLoadedConfig
    : /* turbopackIgnore: true */ process.cwd()
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
      readonly browserBinding?: string
      readonly createdAt: Date
    }): Promise<void>
    read(provider: string, state: string): Promise<{
      readonly provider: string
      readonly state: string
      readonly codeVerifier: string
      readonly guard: string
      readonly browserBinding?: string
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
    : /* turbopackIgnore: true */ process.cwd()
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
      readonly browserBinding?: string
      readonly createdAt: Date
    }) {
      await sessionRuntime.create({
        id: `oauth:${record.provider}:${record.state}`,
        data: {
          provider: record.provider,
          state: record.state,
          codeVerifier: record.codeVerifier,
          guard: record.guard,
          browserBinding: record.browserBinding,
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
        ...(typeof data.browserBinding === 'string' ? { browserBinding: data.browserBinding } : {}),
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

function createCoreHostedIdentityStore(namespace: string): CoreHostedIdentityStore {
  const normalizeRow = (
    row: Record<string, unknown>,
    fallback: {
      readonly provider: string
      readonly providerUserId: string
      readonly authProvider: string
    },
  ): CoreHostedIdentityRecord => {
    const profile = normalizeJsonValue(row.profile)

    /* v8 ignore start -- external identity rows may omit fields; these defaults are defensive normalization guards. */
    return {
      provider: fromHostedIdentityProviderValue(namespace, String(row.provider ?? fallback.provider)),
      providerUserId: String(row.provider_user_id ?? fallback.providerUserId),
      guard: String(row.guard ?? 'web'),
      authProvider: String(row.auth_provider ?? fallback.authProvider),
      userId: normalizeStoredUserId(row.user_id),
      email: typeof row.email === 'string' ? row.email : undefined,
      emailVerified: row.email_verified === true || row.email_verified === 1 || row.email_verified === '1',
      profile: typeof profile === 'object' && profile
        ? profile as Record<string, unknown>
        /* v8 ignore next -- external identity rows with missing or malformed profiles normalize to an empty object. */
        : {},
      linkedAt: normalizeDateValue(row.created_at ?? new Date()),
      updatedAt: normalizeDateValue(row.updated_at ?? new Date()),
    }
    /* v8 ignore stop */
  }

  const findStoredIdentity = async (
    provider: string,
    providerUserId: string,
    authProvider = 'users',
  ): Promise<CoreHostedIdentityRecord | null> => {
    const providerValue = toHostedIdentityProviderValue(namespace, provider)
    const row = await DB.table('auth_identities')
      .where('provider', providerValue)
      .where('provider_user_id', providerUserId)
      .first<Record<string, unknown>>()

    return row
      ? normalizeRow(row, { provider, providerUserId, authProvider })
      : null
  }

  const toPayload = (record: CoreHostedIdentityRecord): Record<string, unknown> => {
    const providerValue = toHostedIdentityProviderValue(namespace, record.provider)

    return {
      user_id: String(record.userId),
      provider: providerValue,
      provider_user_id: record.providerUserId,
      guard: record.guard,
      auth_provider: record.authProvider,
      email: record.email ?? null,
      email_verified: record.emailVerified ? 1 : 0,
      profile: JSON.stringify(record.profile),
      created_at: record.linkedAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
    }
  }

  return Object.freeze({
    async findByProviderUserId(provider: string, providerUserId: string) {
      return await findStoredIdentity(provider, providerUserId)
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

      return normalizeRow(row, {
        provider,
        providerUserId: String(row.provider_user_id),
        authProvider,
      })
    },
    async claim(record: CoreHostedIdentityRecord) {
      const value = record
      await DB.table('auth_identities').insertOrIgnore(toPayload(value))
      const claimed = await findStoredIdentity(value.provider, value.providerUserId, value.authProvider)
      if (!claimed) {
        throw new Error('[@holo-js/core] Claimed hosted identity could not be read back from auth_identities.')
      }

      return claimed
    },
    async save(record: CoreHostedIdentityRecord) {
      const value = record
      const providerValue = toHostedIdentityProviderValue(namespace, value.provider)
      const existing = await DB.table('auth_identities')
        .where('provider', providerValue)
        .where('provider_user_id', value.providerUserId)
        .first<Record<string, unknown>>()
      const payload = toPayload(value)

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
  readonly multiFactor: {
    find(provider: string, userId: string | number): Promise<unknown | null>
    save(record: unknown): Promise<void>
    delete(provider: string, userId: string | number): Promise<void>
    advanceCounter(provider: string, userId: string | number, counter: number): Promise<AuthMultiFactorVerificationState | null>
    consumeRecoveryCode(provider: string, userId: string | number, recoveryCodeHash: string): Promise<AuthMultiFactorVerificationState | null>
    replaceRecoveryCodes(provider: string, userId: string | number, recoveryCodeHashes: readonly string[], updatedAt: Date, verification: AuthMultiFactorVerificationState): Promise<boolean>
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
    multiFactor: Object.freeze({
      async find(provider: string, userId: string | number) {
        const row = await DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .first<Record<string, unknown>>()
        return row ? normalizeMultiFactorCredentialRecord(row) : null
      },
      async save(record: unknown) {
        const value = record as Parameters<typeof serializeMultiFactorCredentialRecord>[0]
        await DB.table('auth_multi_factor_credentials').insert(serializeMultiFactorCredentialRecord(value))
      },
      async delete(provider: string, userId: string | number) {
        await DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .delete()
      },
      async advanceCounter(provider: string, userId: string | number, counter: number) {
        return DB.writeTransaction(async (transaction) => {
          let query = new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
          if (transaction.getCapabilities().lockForUpdate) query = query.lockForUpdate()
          const row = await query.first<Record<string, unknown>>()
          if (!row) return null
          const record = normalizeMultiFactorCredentialRecord(row)
          if (record.lastUsedCounter !== null && counter <= record.lastUsedCounter) return null
          await new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
            .update({ last_used_counter: counter, updated_at: new Date().toISOString() })
          return Object.freeze({ lastUsedCounter: counter, recoveryCodeHashes: record.recoveryCodeHashes })
        })
      },
      async consumeRecoveryCode(provider: string, userId: string | number, recoveryCodeHash: string) {
        return DB.writeTransaction(async (transaction) => {
          let query = new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
          if (transaction.getCapabilities().lockForUpdate) query = query.lockForUpdate()
          const row = await query.first<Record<string, unknown>>()
          if (!row) return null
          const record = normalizeMultiFactorCredentialRecord(row)
          const index = record.recoveryCodeHashes.indexOf(recoveryCodeHash)
          if (index < 0) return null
          const hashes = record.recoveryCodeHashes.filter((_, candidateIndex) => candidateIndex !== index)
          await new TableQueryBuilder('auth_multi_factor_credentials', transaction)
            .where('provider', provider)
            .where('user_id', String(userId))
            .update({ recovery_code_hashes: JSON.stringify(hashes), updated_at: new Date().toISOString() })
          return Object.freeze({ lastUsedCounter: record.lastUsedCounter, recoveryCodeHashes: Object.freeze(hashes) })
        })
      },
      async replaceRecoveryCodes(provider: string, userId: string | number, recoveryCodeHashes: readonly string[], updatedAt: Date, verification: AuthMultiFactorVerificationState) {
        let query = DB.table('auth_multi_factor_credentials')
          .where('provider', provider)
          .where('user_id', String(userId))
          .where('recovery_code_hashes', JSON.stringify(verification.recoveryCodeHashes))
        query = verification.lastUsedCounter === null
          ? query.whereNull('last_used_counter')
          : query.where('last_used_counter', verification.lastUsedCounter)
        const result = await query.update({
          recovery_code_hashes: JSON.stringify(recoveryCodeHashes),
          updated_at: updatedAt.toISOString(),
        })
        return (result.affectedRows ?? 0) > 0
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

    type AuthModelEntity = {
      forceFill?(values: Record<string, unknown>): unknown
    }

    type AuthModelRepository = {
      saveEntity?(entity: unknown, internalColumns?: ReadonlySet<string>): Promise<unknown>
      delete?(id: unknown): Promise<void>
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
      getRepository?(): AuthModelRepository
      create(values: Record<string, unknown>): Promise<unknown>
      update(id: unknown, values: Record<string, unknown>): Promise<unknown>
      delete?(id: unknown): Promise<void>
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
      const sanitizedInput = sanitizeAuthWriteInput(input, {
        enforceFillable: false,
      })
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
      const sanitizedInput = sanitizeAuthWriteInput(input, {
        enforceFillable: false,
      })
      if (typeof resolvedModule.prepareAuthUpdateInput !== 'function') {
        return sanitizedInput
      }

      return sanitizeAuthWriteInput(await resolvedModule.prepareAuthUpdateInput(user, sanitizedInput), {
        enforceFillable: false,
      })
    }

    const saveAuthEntity = async (entity: unknown, values: Record<string, unknown>) => {
      const repository = typeof model.getRepository === 'function'
        ? model.getRepository()
        : null

      if (
        repository
        && typeof repository.saveEntity === 'function'
        && entity
        && typeof entity === 'object'
        && typeof (entity as AuthModelEntity).forceFill === 'function'
      ) {
        ;(entity as AuthModelEntity).forceFill!(values)
        return repository.saveEntity(entity, new Set(Object.keys(values)))
      }

      return null
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

        const firstEntry = entries[0]
        if (!firstEntry) return null
        let query = model.where(firstEntry[0], firstEntry[1])
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
        const values = await prepareAuthCreateInput(input)
        const repository = typeof model.getRepository === 'function'
          ? model.getRepository()
          : null
        const entity = repository && typeof repository.saveEntity === 'function'
          ? new Entity(repository as never, values as never, false)
          : null
        const persisted = entity ? await saveAuthEntity(entity, values) : null

        return markProviderUser(persisted ?? await model.create(values), providerName)
      },
      async delete(id: string | number) {
        const repository = typeof model.getRepository === 'function'
          ? model.getRepository()
          : null
        if (repository && typeof repository.delete === 'function') {
          await repository.delete(id)
          return
        }

        if (typeof model.delete === 'function') {
          await model.delete(id)
          return
        }

        const existing = typeof model.find === 'function'
          ? await model.find(id)
          : null
        if (existing && typeof existing === 'object' && 'delete' in existing && typeof existing.delete === 'function') {
          await existing.delete()
        }
      },
      /* v8 ignore start -- adapter shape mirrors the auth package contract; core tests cover the wired runtime behavior */
      async update(user: unknown, input: Readonly<Record<string, unknown>>) {
        const id = getEntityAttributes(user).id
        const values = await prepareAuthUpdateInput(user, input)
        const existing = typeof model.find === 'function'
          ? await model.find(id)
          : null
        const persisted = existing ? await saveAuthEntity(existing, values) : null

        return markProviderUser(persisted ?? await model.update(id, values), providerName)
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

      queueModule.registerQueueJob(job, {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: Boolean(existing?.sourcePath),
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
        replaceExisting: Boolean(existing?.sourcePath),
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
        replaceExisting: Boolean(existing?.sourcePath),
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
    readonly authRequest?: CreateHoloOptions['authRequest']
    readonly authorizationError?: CreateHoloOptions['authorizationError']
  } = {},
): Promise<{
  readonly queueModule?: QueueModule
  readonly session?: HoloSessionRuntimeBinding
  readonly auth?: HoloAuthRuntimeBinding
  readonly authContext?: {
    activate(): void
    setRequestAccessors?(accessors?: CreateHoloOptions['authRequest']): void
    runWithRequestAccessors?<TValue>(
      accessors: NonNullable<CreateHoloOptions['authRequest']>,
      callback: () => TValue,
    ): TValue
  }
	}> {
  const pluginDefinitions = await loadConfiguredHoloPluginDefinitions(projectRoot, resolveLoadedPluginNames(loadedConfig))
  const cacheConfigured = hasLoadedConfigFile(loadedConfig, 'cache')
  const cacheModule = await loadCacheModule(cacheConfigured, projectRoot)
  const cacheConfig = loadedConfig.cache
  if (cacheModule && cacheConfig) {
    await loadConfiguredCacheDrivers(projectRoot, cacheConfig)
    const configuredPluginDrivers = Object.entries(cacheConfig.drivers).flatMap(([name, driver]) => {
      if (driver.driver === 'memory' || driver.driver === 'file' || driver.driver === 'redis' || driver.driver === 'database') return []
      return [{ ...driver, name, driver: driver.driver }]
    })
    const loadedPluginDrivers = await cacheModule.loadConfiguredCachePluginDriverContracts(
      projectRoot,
      resolveLoadedPluginNames(loadedConfig),
      configuredPluginDrivers,
    )
    const cachePluginDrivers = new Map(loadedPluginDrivers.map(driver => [driver.name, driver]))
    cacheModule.configureCacheRuntime({
      config: cacheConfig,
      databaseConfig: loadedConfig.database,
      redisConfig: loadedConfig.redis,
      ...(cachePluginDrivers.size > 0 ? { drivers: cachePluginDrivers } : {}),
    })
  }

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
      ? await loadQueueDbModule(projectRoot)
      : undefined
    const queueUsesRedis = queueConfigUsesRedisDriver(loadedConfig)
    const queueRedisModule = queueUsesRedis ? await loadQueueRedisModule(projectRoot) : undefined

    /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
    if (queueUsesExplicitDatabaseFeatures && !queueDbModule) {
      throw new Error('[@holo-js/core] Database-backed queue features require @holo-js/queue-db to be installed.')
    }
    if (queueUsesRedis && !queueRedisModule) {
      throw new Error('[@holo-js/core] Redis-backed queue connections require @holo-js/queue-redis to be installed.')
    }
    /* v8 ignore stop */

    const queuePluginDriverFactories = await queueModule.loadQueuePluginDriverFactories(
      projectRoot,
      resolveLoadedPluginNames(loadedConfig),
    )
    const queueDbRuntimeOptions = queueDbModule?.createQueueDbRuntimeOptions() ?? {}
    const queueDriverFactories = mergeQueueRuntimeDriverFactories(
      queuePluginDriverFactories,
      queueDbRuntimeOptions.driverFactories,
      queueRedisModule ? [queueRedisModule.redisQueueDriverFactory] : undefined,
    )
    queueModule.configureQueueRuntime({
      config: loadedConfig.queue,
      redisConfig: loadedConfig.redis,
      ...queueDbRuntimeOptions,
      ...(queueDriverFactories.length > 0 ? { driverFactories: queueDriverFactories } : {}),
    })
  }

  const storageConfigured = hasLoadedConfigFile(loadedConfig, 'storage')
  const storageInstalled = Boolean(await portableRuntimeModuleInternals.importOptionalModule<Record<string, unknown>>('@holo-js/storage'))
  /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!storageInstalled && storageConfigured) {
    throw new Error('[@holo-js/core] Storage support requires @holo-js/storage to be installed.')
  }
  /* v8 ignore stop */

  if (storageInstalled && loadedConfig.storage) {
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
      projectRoot,
      plugins: loadedConfig.app.plugins,
      ...(options.renderView ?? getHoloRenderingRuntime().renderView
        ? { renderView: options.renderView ?? getHoloRenderingRuntime().renderView }
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
      projectRoot,
      plugins: loadedConfig.app.plugins,
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
      deferAfterCommit(callback) {
        const connection = connectionAsyncContext.getActive()?.connection
        if (!connection || connection.getScope().kind === 'root') {
          return false
        }

        connection.afterCommit(callback)
        return true
      },
      projectRoot,
      plugins: loadedConfig.app.plugins,
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
    const existingSecurityStore = existingSecurityBindings?.rateLimitStore
    const shouldReuseExistingSecurityStore = Boolean(existingSecurityStore)
      && !existingManagedSecurityRedisAdapter
      && getRuntimeState().securityRateLimitStoreManaged !== true
    const shouldCloseExistingManagedSecurityStore = !shouldReuseExistingSecurityStore
      && Boolean(existingSecurityStore)
      && (
        Boolean(existingManagedSecurityRedisAdapter)
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
        ? existingSecurityStore
        : securityModule.createRateLimitStoreFromConfig(loadedConfig.security, {
          projectRoot,
          ...(nextManagedSecurityRedisAdapter ? { redisAdapter: nextManagedSecurityRedisAdapter } : {}),
        })

      if (
        shouldCloseExistingManagedSecurityStore
        && existingSecurityStore
        && existingSecurityStore !== rateLimitStore
      ) {
        await existingSecurityStore.close?.()
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
        cors: loadedConfig.cors,
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
  let authContext: ReturnType<AuthModule['createAsyncAuthContext']> & {
    setRequestAccessors?(accessors?: CreateHoloOptions['authRequest']): void
  } | undefined
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

    const baseAuthContext = authModule.createAsyncAuthContext()
    authContext = createRequestAwareAuthContext(baseAuthContext, options.authRequest)
    authModule.configureAuthRuntime({
      config: loadedConfig.auth,
      session: sessionModule.getSessionRuntime(),
      providers: await createCoreAuthProviders(projectRoot, loadedConfig),
      tokens: authStores.tokens,
      emailVerificationTokens: authStores.emailVerificationTokens,
      passwordResetTokens: authStores.passwordResetTokens,
      multiFactor: authStores.multiFactor,
      multiFactorEncryptionKey: loadedConfig.app.key,
      ...(notificationsModule && (mailModule || notificationsRuntimeBindings?.mailer)
        ? { delivery: createAuthNotificationsDeliveryHook(notificationsModule, loadedConfig.app.url, projectRoot) }
        : mailModule
          ? { delivery: createAuthMailDeliveryHook(mailModule, loadedConfig.app.url) }
          : {}),
      context: authContext,
      ...(authorizationModule
        ? {
            authorization: {
              can(user: object, action: string, target: HoloAuthAuthorizationSubject) {
                return authorizationModule.forUser(user).can(action, target)
              },
            },
          }
        : {}),
    })
    const authRuntime = authModule.getAuthRuntime()

    if (authorizationModule) {
      authorizationModule.authorizationInternals.configureAuthorizationAuthIntegration({
        hasGuard(guardName: string) {
          return guardName in loadedConfig.auth.guards
        },
        resolveDefaultActor: async () => authRuntime.user(),
        resolveGuardActor: async (guardName: string) => authRuntime.guard(guardName).user(),
        ...(options.authorizationError?.createError
          ? { createError: options.authorizationError.createError }
          : {}),
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
        identityStore: loadedConfig.auth.workos.identityStore ?? createCoreHostedIdentityStore('workos'),
      })
    }

    if (clerkModule) {
      clerkModule.configureClerkAuthRuntime({
        identityStore: loadedConfig.auth.clerk.identityStore ?? createCoreHostedIdentityStore('clerk'),
      })
    }
  } else if (authorizationModule) {
    authorizationModule.authorizationInternals.resetAuthorizationAuthIntegration()
  }

  for (const bootModule of await loadConfiguredHoloPluginBootModules(projectRoot, pluginDefinitions)) {
    await bootConfiguredHoloPluginModule(projectRoot, loadedConfig, bootModule)
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
  resetBootedHoloPluginModules()
  const projectRoot = getRuntimeState().current?.projectRoot ?? getRuntimeState().pendingProjectRoot
  await resetOptionalStorageRuntime()
  const cacheModule = await loadCacheModule(false, projectRoot)
  if (cacheModule) {
    cacheModule.resetCacheRuntime()
  } else {
    resetCacheRuntimeGlobalsFallback()
  }
  const queueModule = await loadQueueModule()
  if (queueModule) {
    await queueModule.shutdownQueueRuntime()
    queueModule.resetQueueRuntime?.()
  }
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
  await loadInstalledFeatureConfigContributions(projectRoot)
  const loadedConfig = await loadConfigDirectory<TCustom>(projectRoot, {
    envName: options.envName,
    preferCache: options.preferCache,
    processEnv: options.processEnv,
  })
  const fallbackQueueConfig = Object.freeze({
    default: 'sync',
    failed: Object.freeze({
      driver: 'database' as const,
      connection: 'default',
      table: 'failed_jobs',
    }),
    connections: Object.freeze({
      sync: Object.freeze({
        driver: 'sync' as const,
        queue: 'default',
      }),
    }),
  })
  const queueConfig = loadedConfig.queue ?? fallbackQueueConfig
  const runtimeConfig: PortableRuntimeConfig<TCustom> = {
    db: loadedConfig.database,
    queue: queueConfig,
  }
  const databaseDriverFactories = await loadConfiguredDatabaseDrivers(projectRoot, loadedConfig)
  const manager = resolveRuntimeConnectionManagerOptions(runtimeConfig)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  const accessors = createConfigAccessors<RuntimeConfigRegistry<TCustom>>(loadedConfig.all)
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
  let activeAuthContext: {
    activate(): void
    setRequestAccessors?(accessors?: CreateHoloOptions['authRequest']): void
    runWithRequestAccessors?<TValue>(
      accessors: NonNullable<CreateHoloOptions['authRequest']>,
      callback: () => TValue,
    ): TValue
  } | undefined
  let previousOptionalSubsystemBindings: OptionalSubsystemRuntimeBindings<
    SecurityRedisAdapter,
    SessionRedisAdapter
  > | undefined
  const previousRenderView = options.renderView
    ? getHoloRenderingRuntime().renderView
    : undefined
  const fallbackQueueRuntime = Object.freeze({
    config: queueConfig,
    drivers: new Map<string, HoloQueueDriverBinding>(),
  }) as HoloQueueRuntimeBinding

  const unregisterRuntimeContributions = (): void => {
    unregisterProjectEventsAndListeners(activeEventsModule, runtimeOwnedEventNames, runtimeOwnedListenerIds)
    runtimeOwnedEventNames.splice(0)
    runtimeOwnedListenerIds.splice(0)
    unregisterProjectAuthorizationDefinitions(activeAuthorizationModule, runtimeOwnedAuthorizationPolicyNames, runtimeOwnedAuthorizationAbilityNames)
    runtimeOwnedAuthorizationPolicyNames.splice(0)
    runtimeOwnedAuthorizationAbilityNames.splice(0)
    unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
    runtimeOwnedQueueJobNames.splice(0)
    activeAuthorizationModule = undefined
    activeEventsModule = undefined
    activeQueueModule = undefined
    activeSessionRuntime = undefined
    activeAuthRuntime = undefined
    activeAuthContext = undefined
  }

  const applyOptionalSubsystems = async (
    subsystemOptions: HoloRuntimeReconfigureOptions,
  ): Promise<Awaited<ReturnType<typeof reconfigureOptionalHoloSubsystems>>> => {
    const optionalSubsystems = await reconfigureOptionalHoloSubsystems(projectRoot, loadedConfig, {
      renderView: subsystemOptions.renderView,
      authRequest: subsystemOptions.authRequest,
      authorizationError: subsystemOptions.authorizationError,
    })
    activeQueueModule = optionalSubsystems.queueModule
    activeSessionRuntime = optionalSubsystems.session
    activeAuthRuntime = optionalSubsystems.auth
    activeAuthContext = optionalSubsystems.authContext
    return optionalSubsystems
  }

  const initializeRuntimeServices = async (): Promise<void> => {
    if (!shouldBootRuntimeServices(options.processEnv)) return
    await applyOptionalSubsystems(options)
    const optionalEventsModule = activeQueueModule ? await loadEventsModule() : undefined
    if (activeQueueModule && optionalEventsModule) {
      await optionalEventsModule.ensureEventsQueueJobRegisteredAsync?.()
    }
    if (registryHasEvents(registry)) {
      const eventsModule = await loadEventsModule(true)
      if (!eventsModule) throw new Error('[@holo-js/core] Events support requires @holo-js/events to be installed.')
      activeEventsModule = eventsModule
      const eventRegistration = await registerProjectEventsAndListeners(projectRoot, registry, eventsModule, activeQueueModule)
      runtimeOwnedEventNames.push(...eventRegistration.eventNames)
      runtimeOwnedListenerIds.push(...eventRegistration.listenerIds)
    }
    activeAuthorizationModule = await loadAuthorizationModule()
    const authorizationRegistration = await registerProjectAuthorizationDefinitions(projectRoot, registry, activeAuthorizationModule)
    runtimeOwnedAuthorizationPolicyNames.push(...authorizationRegistration.policyNames)
    runtimeOwnedAuthorizationAbilityNames.push(...authorizationRegistration.abilityNames)
    if (options.registerProjectQueueJobs !== false && registryHasJobs(registry)) {
      if (!activeQueueModule) throw new Error('[@holo-js/core] Project jobs require @holo-js/queue to be installed.')
      runtimeOwnedQueueJobNames.push(...await registerProjectQueueJobs(projectRoot, registry, activeQueueModule))
    }
  }

  const runtimeLifecycle = createRuntimeLifecycle([
    {
      name: 'configuration',
      async initialize() {
        configureConfigRuntime(loadedConfig.all)
        await preloadGeneratedSchemaModule(projectRoot, registry)
        await preloadDiscoveredModelModules(projectRoot, registry)
        previousOptionalSubsystemBindings = snapshotOptionalSubsystemRuntimeBindings()
        if (options.renderView) configureHoloRenderingRuntime({ renderView: options.renderView })
      },
      dispose() {
        if (options.renderView) restoreHoloRenderingRuntime(previousRenderView)
        resetConfigRuntime()
      },
    },
    {
      name: 'database',
      dependsOn: ['configuration'],
      async initialize() {
        for (const factory of databaseDriverFactories) registerDatabaseDriverFactory(factory)
        configureDB(manager)
        if (shouldBootRuntimeServices(options.processEnv)) await manager.initializeAll()
      },
      async dispose() {
        try {
          await manager.disconnectAll()
        } finally {
          resetDB()
          for (const factory of [...databaseDriverFactories].reverse()) unregisterDatabaseDriverFactory(factory)
        }
      },
    },
    {
      name: 'optional-subsystems',
      dependsOn: ['database'],
      initialize: initializeRuntimeServices,
      async dispose() {
        unregisterRuntimeContributions()
        try {
          await resetOptionalHoloSubsystems()
        } finally {
          if (previousOptionalSubsystemBindings) restoreOptionalSubsystemRuntimeBindings(previousOptionalSubsystemBindings)
        }
      },
    },
  ])

  const runtime: MutableHoloRuntime<TCustom> & {
    [reconfigureRuntime](options: HoloRuntimeReconfigureOptions): Promise<void>
    setAuthRequestAccessors(accessors?: CreateHoloOptions['authRequest']): void
  } = {
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
      return activeAuthRuntime
    },
    initialized: false,
    useConfig: accessors.useConfig,
    config: accessors.config,
    setAuthRequestAccessors(authRequest) {
      activeAuthContext?.setRequestAccessors?.(authRequest)
    },
    runWithAuthRequestAccessors(authRequest, callback) {
      const runner = activeAuthContext?.runWithRequestAccessors
      return runner ? runner(authRequest, callback) : callback()
    },
    async [reconfigureRuntime](nextOptions) {
      await applyOptionalSubsystems(nextOptions)
    },
    async initialize() {
      if (runtime.initialized) throw new Error('Holo runtime is already initialized.')
      if (getRuntimeState().current) throw new Error('A Holo runtime is already initialized for this process.')
      await runtimeLifecycle.initialize({ projectRoot })
      runtime.initialized = true
      getRuntimeState().current = runtime
    },
    async shutdown() {
      runtime.initialized = false
      if (getRuntimeState().current === runtime) getRuntimeState().current = undefined
      await runtimeLifecycle.dispose({ projectRoot })
    },
  }

  return runtime
}

export async function reconfigureHoloRuntime<TCustom extends HoloConfigMap = HoloConfigMap>(
  runtime: HoloRuntime<TCustom>,
  options: HoloRuntimeReconfigureOptions,
): Promise<void> {
  const reconfigurable = runtime as HoloRuntime<TCustom> & {
    [reconfigureRuntime](nextOptions: HoloRuntimeReconfigureOptions): Promise<void>
  }
  await reconfigurable[reconfigureRuntime](options)
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

    ;(current as HoloRuntime<TCustom> & {
      setAuthRequestAccessors?(accessors?: CreateHoloOptions['authRequest']): void
    }).setAuthRequestAccessors?.(options.authRequest)
    return current
  }

  if (state.pending) {
    if (state.pendingProjectRoot && resolve(state.pendingProjectRoot) !== resolvedProjectRoot) {
      throw new Error(`A Holo runtime is already initializing for "${state.pendingProjectRoot}".`)
    }

    return (state.pending as Promise<HoloRuntime<TCustom>>).then((runtime) => {
      ;(runtime as HoloRuntime<TCustom> & {
        setAuthRequestAccessors?(accessors?: CreateHoloOptions['authRequest']): void
      }).setAuthRequestAccessors?.(options.authRequest)
      return runtime
    })
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
