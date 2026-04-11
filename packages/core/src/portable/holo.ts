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
  getSessionRuntime(): HoloSessionRuntimeBinding
  resetSessionRuntime(): void
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
} {
  const runtime = globalThis as typeof globalThis & {
    __holoRuntime__?: {
      current?: HoloRuntime
      pending?: Promise<HoloRuntime>
      pendingProjectRoot?: string
    }
  }

  runtime.__holoRuntime__ ??= {}
  return runtime.__holoRuntime__
}

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

/* v8 ignore next 15 -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
async function importOptionalModule<TModule>(
  specifier: string,
  options: {
    readonly projectRoot?: string
  } = {},
): Promise<TModule | undefined> {
  const resolvedSpecifier = resolveOptionalImportSpecifier(specifier, options.projectRoot)

  try {
    if (process.env.VITEST) {
      return await import(/* @vite-ignore */ resolvedSpecifier) as TModule
    }

    const indirectEval = globalThis.eval as (source: string) => Promise<TModule>
    return await indirectEval(`import(${JSON.stringify(resolvedSpecifier)})`)
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return undefined
    }
    if (
      error instanceof Error
      && (
        error.message.includes(`Cannot find package '${specifier}'`)
        || error.message.includes(`Cannot find module '${specifier}'`)
        || error.message.includes(`Failed to load url ${specifier}`)
        || error.message.includes(`Cannot find package '${resolvedSpecifier}'`)
        || error.message.includes(`Cannot find module '${resolvedSpecifier}'`)
        || error.message.includes(`Failed to load url ${resolvedSpecifier}`)
      )
    ) {
      return undefined
    }

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

async function loadAuthModule(required = false): Promise<AuthModule | undefined> {
  const authModule = await portableRuntimeModuleInternals.importOptionalModule<AuthModule>('@holo-js/auth')
  if (!authModule && required) {
    throw new Error('[@holo-js/core] Auth support requires @holo-js/auth to be installed.')
  }

  return authModule
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
async function createCoreSessionStores<TCustom extends HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
  sessionModule: SessionModule,
): Promise<Readonly<Record<string, {
  read(sessionId: string): Promise<unknown | null>
  write(record: unknown): Promise<void>
  delete(sessionId: string): Promise<void>
}>>> {
  const stores: Record<string, {
    read(sessionId: string): Promise<unknown | null>
    write(record: unknown): Promise<void>
    delete(sessionId: string): Promise<void>
  }> = {}

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
    }
  }

  if (!(loadedConfig.session.driver in stores)) {
    throw new Error(
      `[@holo-js/core] Session driver "${loadedConfig.session.driver}" is configured but the runtime cannot boot it automatically.`,
    )
  }

  return Object.freeze(stores)
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
        continue
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

  const sessionConfigured = hasLoadedConfigFile(loadedConfig, 'session') || hasLoadedConfigFile(loadedConfig, 'auth')
  const authConfigured = hasLoadedConfigFile(loadedConfig, 'auth')
  const sessionModule = sessionConfigured || authConfigured
    ? await loadSessionModule(true)
    : undefined

  /* v8 ignore start -- redundant defensive guards after required-module loaders above */
  if (authConfigured && !sessionModule) {
    throw new Error('[@holo-js/core] Auth support requires @holo-js/session to be installed.')
  }

  const authModule = await loadAuthModule(authConfigured)
  let authContext: ReturnType<AuthModule['createAsyncAuthContext']> | undefined
  const workosModule = authConfigUsesWorkosProviders(loadedConfig)
    ? await loadWorkosModule(true)
    : undefined
  const clerkModule = authConfigUsesClerkProviders(loadedConfig)
    ? await loadClerkModule(true)
    : undefined

  if (sessionModule) {
    const stores = await createCoreSessionStores(projectRoot, loadedConfig, sessionModule)
    sessionModule.configureSessionRuntime({
      config: loadedConfig.session,
      stores,
    })
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
      context: authContext,
    })

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
  await resetOptionalStorageRuntime()
  const queueModule = await loadQueueModule()
  await queueModule?.shutdownQueueRuntime()
  const authModule = await loadAuthModule()
  authModule?.resetAuthRuntime()
  const socialModule = await loadSocialModule()
  socialModule?.resetSocialAuthRuntime()
  const workosModule = await loadWorkosModule()
  workosModule?.resetWorkosAuthRuntime()
  const clerkModule = await loadClerkModule()
  clerkModule?.resetClerkAuthRuntime()
  const sessionModule = await loadSessionModule()
  sessionModule?.resetSessionRuntime()
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
  let activeQueueModule: QueueModule | undefined
  let activeEventsModule: EventsModule | undefined
  let activeSessionRuntime: HoloSessionRuntimeBinding | undefined
  let activeAuthRuntime: HoloAuthRuntimeBinding | undefined
  let activeAuthContext: { activate(): void } | undefined
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

      try {
        await manager.initializeAll()

        const optionalSubsystems = await reconfigureOptionalHoloSubsystems(projectRoot, loadedConfig)
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
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeEventsModule = undefined
        activeQueueModule = undefined
        activeSessionRuntime = undefined
        activeAuthRuntime = undefined
        activeAuthContext = undefined
        await manager.disconnectAll().catch(() => {})
        resetDB()
        await resetOptionalHoloSubsystems()
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
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeEventsModule = undefined
        activeQueueModule = undefined
        activeSessionRuntime = undefined
        activeAuthRuntime = undefined
        activeAuthContext = undefined
        resetDB()
        await resetOptionalHoloSubsystems()
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
  getRuntimeState().pending = undefined
  getRuntimeState().pendingProjectRoot = undefined
  if (!current) {
    resetDB()
    await resetOptionalHoloSubsystems()
    resetConfigRuntime()
    return
  }

  await current.shutdown()
}

function getConfigValue(path: string): unknown {
  return globalConfig(path as never)
}

function getConfigSection(key: string): unknown {
  return globalUseConfig(key as never)
}

export const holoRuntimeInternals = {
  bindAuthRuntimeToContext,
  createCoreAuthProviders,
  createCoreAuthStores,
  createCoreHostedIdentityStore,
  createCoreSessionStores,
  fromHostedIdentityProviderValue: fromHostedIdentityProviderValue,
  getConfigSection,
  getConfigValue,
  createCoreSocialBindings,
  loadConfiguredSocialProviders,
  markProviderUser,
  normalizeDateValue,
  normalizeEmailVerificationTokenRecord,
  normalizeJsonValue,
  normalizePasswordResetTokenRecord,
  moduleInternals: portableRuntimeModuleInternals,
}
