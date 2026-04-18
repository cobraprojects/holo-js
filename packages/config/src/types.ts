import type { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/db'

export interface HoloProjectPaths {
  models: string
  migrations: string
  generatedSchema: string
  seeders: string
  observers: string
  factories: string
  commands: string
  jobs: string
}

export interface HoloProjectConnectionConfig {
  driver?: SupportedDatabaseDriver
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  filename?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging?: boolean
}

export interface HoloProjectDatabaseConfig {
  defaultConnection?: string
  connections?: Record<string, HoloProjectConnectionConfig | string>
}

export interface HoloProjectConfig {
  paths?: Partial<HoloProjectPaths>
  database?: HoloProjectDatabaseConfig
  models?: readonly string[]
  migrations?: readonly string[]
  seeders?: readonly string[]
}

export type SupportedDatabaseDriver = 'sqlite' | 'postgres' | 'mysql'
export type HoloAppEnv = 'development' | 'production' | 'test'

export interface HoloAppConfig extends HoloProjectConfig {
  name?: string
  key?: string
  url?: string
  debug?: boolean
  env?: HoloAppEnv
}

export type HoloDatabaseConnectionConfig = HoloProjectConnectionConfig
export type HoloDatabaseConfig = HoloProjectDatabaseConfig

export type StorageDriver = 'local' | 'public' | 's3'
export type StorageVisibility = 'private' | 'public'

export interface BaseDiskConfig {
  driver: StorageDriver
  visibility?: StorageVisibility
  root?: string
  url?: string
  [key: string]: unknown
}

export interface LocalDiskConfig extends BaseDiskConfig {
  driver: 'local' | 'public'
}

export interface S3DiskConfig extends BaseDiskConfig {
  driver: 's3'
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

export type DiskConfig = LocalDiskConfig | S3DiskConfig

export interface HoloStorageConfig {
  defaultDisk?: string
  routePrefix?: string
  disks?: Record<string, DiskConfig>
}

export interface HoloMediaConfig {
  [key: string]: unknown
}

export type BroadcastConnectionDriver = 'holo' | 'pusher' | 'log' | 'null'
export type BroadcastConnectionScheme = 'http' | 'https'

export interface BroadcastConnectionOptionsConfig {
  readonly host?: string
  readonly port?: number | string
  readonly scheme?: BroadcastConnectionScheme
  readonly useTLS?: boolean
  readonly cluster?: string
}

export interface BroadcastWorkerScalingConfig {
  readonly driver: 'redis'
  readonly connection?: string
}

export interface BroadcastWorkerConfig {
  readonly host?: string
  readonly port?: number | string
  readonly path?: string
  readonly publicHost?: string
  readonly publicPort?: number | string
  readonly publicScheme?: BroadcastConnectionScheme
  readonly healthPath?: string
  readonly statsPath?: string
  readonly scaling?: false | BroadcastWorkerScalingConfig
}

export type BroadcastConnectionConfigValue =
  | string
  | number
  | boolean
  | object
  | undefined

export interface BaseBroadcastConnectionConfig {
  readonly driver: BroadcastConnectionDriver | (string & {})
  readonly options?: BroadcastConnectionOptionsConfig
  readonly clientOptions?: Readonly<Record<string, unknown>>
  readonly [key: string]: BroadcastConnectionConfigValue
}

export interface HoloBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'holo'
  readonly key?: string
  readonly secret?: string
  readonly appId?: string | number
}

export interface PusherBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'pusher'
  readonly key?: string
  readonly secret?: string
  readonly appId?: string | number
}

export interface LogBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'log'
}

export interface NullBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'null'
}

export type HoloBroadcastConnection
  = HoloBroadcastConnectionConfig
  | PusherBroadcastConnectionConfig
  | LogBroadcastConnectionConfig
  | NullBroadcastConnectionConfig
  | BaseBroadcastConnectionConfig

export interface HoloBroadcastConfig {
  readonly default?: string
  readonly connections?: Readonly<Record<string, HoloBroadcastConnection>>
  readonly worker?: BroadcastWorkerConfig
}

export interface NormalizedBroadcastConnectionOptionsConfig {
  readonly host: string
  readonly port: number
  readonly scheme: BroadcastConnectionScheme
  readonly useTLS: boolean
  readonly cluster?: string
}

export interface NormalizedBroadcastWorkerScalingConfig {
  readonly driver: 'redis'
  readonly connection: string
}

export interface NormalizedBroadcastWorkerConfig {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly publicHost?: string
  readonly publicPort?: number
  readonly publicScheme: BroadcastConnectionScheme
  readonly healthPath: string
  readonly statsPath: string
  readonly scaling: false | NormalizedBroadcastWorkerScalingConfig
}

export interface NormalizedBaseBroadcastConnectionConfig {
  readonly name: string
  readonly driver: string
  readonly clientOptions: Readonly<Record<string, unknown>>
}

export interface NormalizedHoloBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'holo'
  readonly key: string
  readonly secret: string
  readonly appId: string
  readonly options: NormalizedBroadcastConnectionOptionsConfig
}

export interface NormalizedPusherBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'pusher'
  readonly key: string
  readonly secret: string
  readonly appId: string
  readonly options: NormalizedBroadcastConnectionOptionsConfig
}

export interface NormalizedLogBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'log'
}

export interface NormalizedNullBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'null'
}

export type NormalizedHoloBroadcastConnection
  = NormalizedHoloBroadcastConnectionConfig
  | NormalizedPusherBroadcastConnectionConfig
  | NormalizedLogBroadcastConnectionConfig
  | NormalizedNullBroadcastConnectionConfig
  | NormalizedBaseBroadcastConnectionConfig

export interface NormalizedHoloBroadcastConfig {
  readonly default: string
  readonly connections: Readonly<Record<string, NormalizedHoloBroadcastConnection>>
  readonly worker: NormalizedBroadcastWorkerConfig
}

export type SessionCookieSameSite = 'lax' | 'strict' | 'none'

export interface HoloSessionCookieConfig {
  readonly name?: string
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: SessionCookieSameSite
  readonly partitioned?: boolean
  readonly maxAge?: number | string
}

export interface SessionFileStoreConfig {
  readonly driver: 'file'
  readonly path?: string
}

export interface SessionDatabaseStoreConfig {
  readonly driver: 'database'
  readonly connection?: string
  readonly table?: string
}

export interface SessionRedisStoreConfig {
  readonly driver: 'redis'
  readonly connection?: string
  readonly prefix?: string
}

export type SessionStoreConfig
  = SessionFileStoreConfig
  | SessionDatabaseStoreConfig
  | SessionRedisStoreConfig

export interface HoloSessionConfig {
  readonly driver?: string
  readonly stores?: Readonly<Record<string, SessionStoreConfig>>
  readonly cookie?: HoloSessionCookieConfig
  readonly idleTimeout?: number | string
  readonly absoluteLifetime?: number | string
  readonly rememberMeLifetime?: number | string
}

export interface NormalizedHoloSessionCookieConfig {
  readonly name: string
  readonly path: string
  readonly domain?: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: SessionCookieSameSite
  readonly partitioned: boolean
  readonly maxAge: number
}

export interface NormalizedSessionFileStoreConfig {
  readonly name: string
  readonly driver: 'file'
  readonly path: string
}

export interface NormalizedSessionDatabaseStoreConfig {
  readonly name: string
  readonly driver: 'database'
  readonly connection: string
  readonly table: string
}

export interface NormalizedSessionRedisStoreConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly connection: string
  readonly prefix: string
}

export type NormalizedSessionStoreConfig
  = NormalizedSessionFileStoreConfig
  | NormalizedSessionDatabaseStoreConfig
  | NormalizedSessionRedisStoreConfig

export interface NormalizedHoloSessionConfig {
  readonly driver: string
  readonly stores: Readonly<Record<string, NormalizedSessionStoreConfig>>
  readonly cookie: NormalizedHoloSessionCookieConfig
  readonly idleTimeout: number
  readonly absoluteLifetime: number
  readonly rememberMeLifetime: number
}

export type SecurityRateLimitDriver = 'memory' | 'file' | 'redis'

export interface HoloSecurityCsrfConfig {
  readonly enabled?: boolean
  readonly field?: string
  readonly header?: string
  readonly cookie?: string
  readonly except?: readonly string[]
}

export interface NormalizedHoloSecurityCsrfConfig {
  readonly enabled: boolean
  readonly field: string
  readonly header: string
  readonly cookie: string
  readonly except: readonly string[]
}

export interface SecurityRateLimitContext<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly request: Request
  readonly values?: TValues
}

export interface SecurityRateLimitKeyResolver<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  (context: SecurityRateLimitContext<TValues>): string
}

export interface SecurityLimiterConfig<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly maxAttempts: number | string
  readonly decaySeconds: number | string
  readonly key?: SecurityRateLimitKeyResolver<TValues>
}

export interface NormalizedSecurityLimiterConfig<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly name: string
  readonly maxAttempts: number
  readonly decaySeconds: number
  readonly key?: SecurityRateLimitKeyResolver<TValues>
}

export interface SecurityRateLimitMemoryConfig {
  readonly driver?: 'memory'
}

export interface SecurityRateLimitFileConfig {
  readonly path?: string
}

export interface SecurityRateLimitRedisConnectionConfig {
  readonly host?: string
  readonly port?: number | string
  readonly password?: string
  readonly username?: string
  readonly db?: number | string
}

export interface SecurityRateLimitRedisConfig {
  readonly host?: string
  readonly port?: number | string
  readonly password?: string
  readonly username?: string
  readonly db?: number | string
  readonly connection?: string
  readonly prefix?: string
}

export interface HoloSecurityRateLimitConfig {
  readonly driver?: SecurityRateLimitDriver
  readonly memory?: SecurityRateLimitMemoryConfig
  readonly file?: SecurityRateLimitFileConfig
  readonly redis?: SecurityRateLimitRedisConfig
  readonly limiters?: Readonly<Record<string, SecurityLimiterConfig>>
}

export interface NormalizedSecurityRateLimitMemoryConfig {
  readonly driver: 'memory'
}

export interface NormalizedSecurityRateLimitFileConfig {
  readonly path: string
}

export interface NormalizedSecurityRateLimitRedisConfig {
  readonly host: string
  readonly port: number
  readonly password?: string
  readonly username?: string
  readonly db: number
  readonly connection: string
  readonly prefix: string
}

export interface NormalizedHoloSecurityRateLimitConfig {
  readonly driver: SecurityRateLimitDriver
  readonly memory: NormalizedSecurityRateLimitMemoryConfig
  readonly file: NormalizedSecurityRateLimitFileConfig
  readonly redis: NormalizedSecurityRateLimitRedisConfig
  readonly limiters: Readonly<Record<string, NormalizedSecurityLimiterConfig>>
}

export interface HoloSecurityConfig {
  readonly csrf?: boolean | HoloSecurityCsrfConfig
  readonly rateLimit?: HoloSecurityRateLimitConfig
}

export interface NormalizedHoloSecurityConfig {
  readonly csrf: NormalizedHoloSecurityCsrfConfig
  readonly rateLimit: NormalizedHoloSecurityRateLimitConfig
}

export type AuthGuardDriver = 'session' | 'token'

export interface AuthGuardConfig {
  readonly driver: AuthGuardDriver
  readonly provider?: string
}

export interface AuthProviderConfig {
  readonly model: string
  readonly identifiers?: readonly string[]
}

export interface AuthPasswordBrokerConfig {
  readonly provider?: string
  readonly table?: string
  readonly expire?: number | string
  readonly throttle?: number | string
}

export interface AuthEmailVerificationConfig {
  readonly required?: boolean
}

export interface AuthPersonalAccessTokenConfig {
  readonly defaultAbilities?: readonly string[]
}

export interface AuthSocialProviderConfig {
  readonly runtime?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly scopes?: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
  readonly encryptTokens?: boolean
}

export interface AuthWorkosProviderConfig {
  readonly clientId?: string
  readonly apiKey?: string
  readonly cookiePassword?: string
  readonly redirectUri?: string
  readonly sessionCookie?: string
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface AuthClerkProviderConfig {
  readonly publishableKey?: string
  readonly secretKey?: string
  readonly jwtKey?: string
  readonly apiUrl?: string
  readonly frontendApi?: string
  readonly sessionCookie?: string
  readonly authorizedParties?: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface HoloAuthConfig {
  readonly defaults?: {
    readonly guard?: string
    readonly passwords?: string
  }
  readonly guards?: Readonly<Record<string, AuthGuardConfig>>
  readonly providers?: Readonly<Record<string, AuthProviderConfig>>
  readonly passwords?: Readonly<Record<string, AuthPasswordBrokerConfig>>
  readonly emailVerification?: boolean | AuthEmailVerificationConfig
  readonly personalAccessTokens?: AuthPersonalAccessTokenConfig
  readonly socialEncryptionKey?: string
  readonly social?: Readonly<Record<string, AuthSocialProviderConfig>>
  readonly workos?: Readonly<Record<string, AuthWorkosProviderConfig>>
  readonly clerk?: Readonly<Record<string, AuthClerkProviderConfig>>
}

export interface NormalizedAuthGuardConfig {
  readonly name: string
  readonly driver: AuthGuardDriver
  readonly provider: string
}

export interface NormalizedAuthProviderConfig {
  readonly name: string
  readonly model: string
  readonly identifiers: readonly string[]
}

export interface NormalizedAuthPasswordBrokerConfig {
  readonly name: string
  readonly provider: string
  readonly table: string
  readonly expire: number
  readonly throttle: number
}

export interface NormalizedAuthSocialProviderConfig {
  readonly name: string
  readonly runtime?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly scopes: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
  readonly encryptTokens: boolean
}

export interface NormalizedAuthWorkosProviderConfig {
  readonly name: string
  readonly clientId?: string
  readonly apiKey?: string
  readonly cookiePassword?: string
  readonly redirectUri?: string
  readonly sessionCookie: string
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface NormalizedAuthClerkProviderConfig {
  readonly name: string
  readonly publishableKey?: string
  readonly secretKey?: string
  readonly jwtKey?: string
  readonly apiUrl?: string
  readonly frontendApi?: string
  readonly sessionCookie: string
  readonly authorizedParties: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface NormalizedHoloAuthConfig {
  readonly defaults: {
    readonly guard: string
    readonly passwords: string
  }
  readonly guards: Readonly<Record<string, NormalizedAuthGuardConfig>>
  readonly providers: Readonly<Record<string, NormalizedAuthProviderConfig>>
  readonly passwords: Readonly<Record<string, NormalizedAuthPasswordBrokerConfig>>
  readonly emailVerification: {
    readonly required: boolean
  }
  readonly personalAccessTokens: {
    readonly defaultAbilities: readonly string[]
  }
  readonly socialEncryptionKey?: string
  readonly social: Readonly<Record<string, NormalizedAuthSocialProviderConfig>>
  readonly workos: Readonly<Record<string, NormalizedAuthWorkosProviderConfig>>
  readonly clerk: Readonly<Record<string, NormalizedAuthClerkProviderConfig>>
}

export interface QueueRedisConnectionConfig {
  readonly driver: 'redis'
  readonly queue?: string
  readonly retryAfter?: number | string
  readonly blockFor?: number | string
  readonly redis?: {
    readonly host?: string
    readonly port?: number | string
    readonly password?: string
    readonly username?: string
    readonly db?: number | string
  }
}

export interface QueueDatabaseConnectionConfig {
  readonly driver: 'database'
  readonly queue?: string
  readonly retryAfter?: number | string
  readonly sleep?: number | string
  readonly connection?: string
  readonly table?: string
}

export interface QueueFailedStoreConfig {
  readonly driver?: 'database'
  readonly connection?: string
  readonly table?: string
}

export interface QueueSyncConnectionConfig {
  readonly driver: 'sync'
  readonly queue?: string
}

export type QueueConnectionConfig
  = QueueSyncConnectionConfig
  | QueueRedisConnectionConfig
  | QueueDatabaseConnectionConfig

export interface HoloQueueConfig {
  readonly default?: string
  readonly failed?: false | QueueFailedStoreConfig
  readonly connections?: Readonly<Record<string, QueueConnectionConfig>>
}

export interface NormalizedQueueFailedStoreConfig {
  readonly driver: 'database'
  readonly connection: string
  readonly table: string
}

export interface NormalizedQueueSyncConnectionConfig {
  readonly name: string
  readonly driver: 'sync'
  readonly queue: string
}

export interface NormalizedQueueRedisConnectionConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly queue: string
  readonly retryAfter: number
  readonly blockFor: number
  readonly redis: {
    readonly host: string
    readonly port: number
    readonly password?: string
    readonly username?: string
    readonly db: number
  }
}

export interface NormalizedQueueDatabaseConnectionConfig {
  readonly name: string
  readonly driver: 'database'
  readonly queue: string
  readonly retryAfter: number
  readonly sleep: number
  readonly connection: string
  readonly table: string
}

export type NormalizedQueueConnectionConfig
  = NormalizedQueueSyncConnectionConfig
  | NormalizedQueueRedisConnectionConfig
  | NormalizedQueueDatabaseConnectionConfig

export interface NormalizedHoloQueueConfig {
  readonly default: string
  readonly failed: false | NormalizedQueueFailedStoreConfig
  readonly connections: Readonly<Record<string, NormalizedQueueConnectionConfig>>
}

export interface NormalizedHoloAppConfig {
  readonly name: string
  readonly key: string
  readonly url: string
  readonly debug: boolean
  readonly env: HoloAppEnv
  readonly paths: Readonly<HoloProjectPaths>
  readonly models: readonly string[]
  readonly migrations: readonly string[]
  readonly seeders: readonly string[]
}

export interface NormalizedHoloDatabaseConfig {
  readonly defaultConnection?: string
  readonly connections: Readonly<Record<string, HoloDatabaseConnectionConfig | string>>
}

export interface NormalizedHoloStorageConfig {
  readonly defaultDisk?: string
  readonly routePrefix: string
  readonly disks: Readonly<Record<string, DiskConfig>>
}

export interface HoloNotificationsConfig {
  readonly table?: string
  readonly queue?: {
    readonly connection?: string
    readonly queue?: string
    readonly afterCommit?: boolean
  }
}

export interface NormalizedHoloNotificationsConfig {
  readonly table: string
  readonly queue: {
    readonly connection?: string
    readonly queue?: string
    readonly afterCommit: boolean
  }
}

export interface HoloMailAddressConfig {
  readonly email: string
  readonly name?: string
}

export interface HoloMailQueueConfig {
  readonly queued?: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit?: boolean
}

export interface HoloMailPreviewConfig {
  readonly allowedEnvironments?: readonly HoloAppEnv[]
}

export interface HoloMailMarkdownConfig {
  readonly wrapper?: string
}

export interface BaseMailDriverConfig {
  readonly driver: string
  readonly from?: HoloMailAddressConfig
  readonly replyTo?: HoloMailAddressConfig
  readonly queue?: HoloMailQueueConfig
}

export interface PreviewMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'preview'
  readonly path?: string
}

export interface LogMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'log'
  readonly logBodies?: boolean
}

export interface FakeMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'fake'
}

export interface SmtpMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'smtp'
  readonly host?: string
  readonly port?: number | string
  readonly secure?: boolean
  readonly user?: string
  readonly password?: string
}

export type HoloMailMailerConfig
  = PreviewMailDriverConfig
  | LogMailDriverConfig
  | FakeMailDriverConfig
  | SmtpMailDriverConfig
  | (BaseMailDriverConfig & Record<string, unknown>)

export interface HoloMailConfig {
  readonly default?: string
  readonly from?: HoloMailAddressConfig
  readonly replyTo?: HoloMailAddressConfig
  readonly queue?: HoloMailQueueConfig
  readonly preview?: HoloMailPreviewConfig
  readonly markdown?: HoloMailMarkdownConfig
  readonly mailers?: Readonly<Record<string, HoloMailMailerConfig>>
}

export interface NormalizedHoloMailAddressConfig {
  readonly email: string
  readonly name?: string
}

export interface NormalizedHoloMailQueueConfig {
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit: boolean
}

export interface NormalizedHoloMailPreviewConfig {
  readonly allowedEnvironments: readonly HoloAppEnv[]
}

export interface NormalizedHoloMailMarkdownConfig {
  readonly wrapper?: string
}

export interface NormalizedBaseMailDriverConfig {
  readonly name: string
  readonly driver: string
  readonly from?: NormalizedHoloMailAddressConfig
  readonly replyTo?: NormalizedHoloMailAddressConfig
  readonly queue: NormalizedHoloMailQueueConfig
}

export interface NormalizedPreviewMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'preview'
  readonly path: string
}

export interface NormalizedLogMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'log'
  readonly logBodies: boolean
}

export interface NormalizedFakeMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'fake'
}

export interface NormalizedSmtpMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'smtp'
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string
  readonly password?: string
}

export type NormalizedHoloMailMailerConfig
  = NormalizedPreviewMailDriverConfig
  | NormalizedLogMailDriverConfig
  | NormalizedFakeMailDriverConfig
  | NormalizedSmtpMailDriverConfig
  | NormalizedBaseMailDriverConfig

export interface NormalizedHoloMailConfig {
  readonly default: string
  readonly from?: NormalizedHoloMailAddressConfig
  readonly replyTo?: NormalizedHoloMailAddressConfig
  readonly queue: NormalizedHoloMailQueueConfig
  readonly preview: NormalizedHoloMailPreviewConfig
  readonly markdown: NormalizedHoloMailMarkdownConfig
  readonly mailers: Readonly<Record<string, NormalizedHoloMailMailerConfig>>
}

export interface HoloConfigRegistry {
  app: NormalizedHoloAppConfig
  database: NormalizedHoloDatabaseConfig
  storage: NormalizedHoloStorageConfig
  queue: NormalizedHoloQueueConfig
  broadcast: NormalizedHoloBroadcastConfig
  mail: NormalizedHoloMailConfig
  notifications: NormalizedHoloNotificationsConfig
  media: HoloMediaConfig
  session: NormalizedHoloSessionConfig
  security: NormalizedHoloSecurityConfig
  auth: NormalizedHoloAuthConfig
}

export type HoloConfigMap = object

export interface LoadedEnvironment {
  readonly name: HoloAppEnv
  readonly values: Readonly<Record<string, string>>
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export interface LoadedHoloConfig<TCustom extends HoloConfigMap = HoloConfigMap> {
  readonly app: NormalizedHoloAppConfig
  readonly database: NormalizedHoloDatabaseConfig
  readonly storage: NormalizedHoloStorageConfig
  readonly queue: NormalizedHoloQueueConfig
  readonly broadcast: NormalizedHoloBroadcastConfig
  readonly mail: NormalizedHoloMailConfig
  readonly notifications: NormalizedHoloNotificationsConfig
  readonly media: HoloMediaConfig
  readonly session: NormalizedHoloSessionConfig
  readonly security: NormalizedHoloSecurityConfig
  readonly auth: NormalizedHoloAuthConfig
  readonly custom: Readonly<TCustom>
  readonly all: Readonly<HoloConfigRegistry & TCustom>
  readonly environment: LoadedEnvironment
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export type ConfigFileName = keyof HoloConfigRegistry | (string & {})

type Primitive = string | number | boolean | bigint | symbol | null | undefined
type NonTraversable = Primitive | readonly unknown[] | ((...args: never[]) => unknown)
type KnownPathKey<T> = Extract<{
  [K in keyof T]:
  K extends string
    ? string extends K
      ? never
      : K
    : never
}[keyof T], string>

export type DotPath<T> = T extends NonTraversable
  ? never
  : {
      [K in KnownPathKey<T>]:
      T[K] extends NonTraversable
        ? K
        : T[K] extends object
          ? K | `${K}.${DotPath<T[K]>}`
          : K
    }[KnownPathKey<T>]

export type ValueAtPath<T, TPath extends string>
  = TPath extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? ValueAtPath<T[Head], Tail>
      : never
    : TPath extends keyof T
      ? T[TPath]
      : never

export type DefineConfigValue<TConfig extends object> = Readonly<TConfig>

export type HoloProjectDefaults = typeof DEFAULT_HOLO_PROJECT_PATHS
