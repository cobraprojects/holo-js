import {
  DB,
  TableQueryBuilder,
  collectDatabaseQueryDependencies,
  onDatabaseDependencyInvalidated,
  type DatabaseContext,
  type DatabaseDependencyInvalidationEvent,
} from '@holo-js/db'
import { validate } from '@holo-js/validation'
import type { ValidationSchema } from '@holo-js/validation'
import type {
  RealtimeAccess,
  RealtimeAccessObject,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeAuthModule,
  RealtimeAuthState,
  RealtimeDatabaseContext,
  RealtimeExecutionResult,
  RealtimeMutationDefinition,
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinition,
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
  RealtimeRuntimeBindings,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
  RealtimeSubscriptionSnapshot,
} from './contracts'

const REALTIME_DEFINITION_MARKER = Symbol.for('holo-js.realtime.definition')

type RuntimeState = {
  bindings?: RealtimeRuntimeBindings
  nextDefinitionId: number
  nextSubscriptionId: number
  unsubscribeFromDatabase?: () => void
  subscriptions: Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>
}

type ActiveSubscription<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly id: string
  readonly definition: TDefinition
  readonly args: RealtimeArgsFor<TDefinition>
  readonly options: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>
  dependencies: readonly string[]
  version: number
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
}

export class RealtimeError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'RealtimeError'
  }
}

export class RealtimeUnauthorizedError extends RealtimeError {
  constructor(message = 'Realtime access denied.') {
    super(message)
    this.name = 'RealtimeUnauthorizedError'
  }
}

export class RealtimeForbiddenError extends RealtimeError {
  constructor(message = 'Realtime access forbidden.') {
    super(message)
    this.name = 'RealtimeForbiddenError'
  }
}

export class RealtimeAuthUnavailableError extends RealtimeError {
  constructor(
    message = 'Realtime authenticated access requires @holo-js/auth to be installed and configured.',
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'RealtimeAuthUnavailableError'
  }
}

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeRuntime__?: RuntimeState
  }

  runtime.__holoRealtimeRuntime__ ??= {
    nextDefinitionId: 0,
    nextSubscriptionId: 0,
    subscriptions: new Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>(),
  }
  return runtime.__holoRealtimeRuntime__
}

function createRealtimeDatabaseContext(connection: DatabaseContext): RealtimeDatabaseContext {
  return Object.freeze({
    connection,
    table(table: string) {
      return new TableQueryBuilder(table, connection) as ReturnType<RealtimeDatabaseContext['table']>
    },
    model(...parameters: Parameters<DatabaseContext['model']>) {
      return connection.model(...parameters) as ReturnType<DatabaseContext['model']>
    },
  })
}

function getDatabaseContext(): RealtimeDatabaseContext {
  return createRealtimeDatabaseContext(getRuntimeState().bindings?.db?.() ?? DB.connection())
}

function nextDefinitionName(kind: 'query' | 'mutation'): string {
  const state = getRuntimeState()
  state.nextDefinitionId += 1
  return `realtime.${kind}.${state.nextDefinitionId}`
}

function markDefinition<TDefinition extends object>(definition: TDefinition): TDefinition {
  return Object.freeze(Object.defineProperty(definition, REALTIME_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  }))
}

export function isRealtimeDefinition(value: unknown): value is RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata {
  return !!(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && (value as { readonly [REALTIME_DEFINITION_MARKER]?: unknown })[REALTIME_DEFINITION_MARKER] === true
  )
}

async function defaultLoadAuthModule(): Promise<RealtimeAuthModule | null> {
  try {
    return await import('@holo-js/auth') as RealtimeAuthModule
  /* v8 ignore start -- optional peer dependency absence depends on package installation state */
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { readonly code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return null
    }

    throw error
  }
  /* v8 ignore stop */
}

async function loadAuthModule(): Promise<RealtimeAuthModule | null> {
  const load = getRuntimeState().bindings?.loadAuthModule ?? defaultLoadAuthModule
  return await load()
}

function normalizeAccess<TArgs>(access: RealtimeAccess<TArgs>): RealtimeAccessObject<TArgs> {
  if (access === 'public' || access === 'authenticated') {
    return Object.freeze({
      require: access,
    })
  }

  if (access.guards && access.guard) {
    throw new RealtimeError('Realtime access cannot define both guard and guards.')
  }

  if (access.guards && access.guards.length === 0) {
    throw new RealtimeError('Realtime access guards must not be empty.')
  }

  return access
}

async function resolveGuardAuth(
  authModule: RealtimeAuthModule,
  guardName: string | undefined,
): Promise<RealtimeAuthState | null> {
  const runtime = authModule.getAuthRuntime()
  const guard = guardName ? runtime.guard(guardName) : runtime
  const user = await guard.user()
  if (!user) {
    return null
  }

  return Object.freeze({
    user,
    guard: guardName ?? 'default',
    provider: await guard.provider(),
  })
}

async function resolveAuthForAccess<TArgs>(
  access: RealtimeAccessObject<TArgs>,
): Promise<RealtimeAuthState | null> {
  let authModule: RealtimeAuthModule | null = null
  try {
    authModule = await loadAuthModule()
  } catch (error) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError('Realtime authenticated access requires @holo-js/auth to be installed and configured.', {
        cause: error,
      })
    }

    return null
  }

  if (!authModule) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError()
    }

    return null
  }

  const guardNames = access.guards ?? (access.guard ? [access.guard] : [undefined])
  try {
    for (const guardName of guardNames) {
      const auth = await resolveGuardAuth(authModule, guardName)
      if (auth) {
        return auth
      }
    }
  } catch (error) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError('Realtime authenticated access requires @holo-js/auth to be installed and configured.', {
        cause: error,
      })
    }

    return null
  }

  if (access.require === 'authenticated') {
    throw new RealtimeUnauthorizedError()
  }

  return null
}

async function authorize<TArgs>(
  accessInput: RealtimeAccess<TArgs>,
  args: TArgs,
  db: RealtimeDatabaseContext,
): Promise<RealtimeAuthState | null> {
  const access = normalizeAccess(accessInput)
  const auth = await resolveAuthForAccess(access)

  if (access.authorize) {
    const allowed = await access.authorize({
      args,
      auth: auth as RealtimeAuthState,
      db,
    })
    if (!allowed) {
      throw new RealtimeForbiddenError()
    }
  }

  return auth
}

async function resolveArgs<TDefinition extends (RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata) & {
  readonly args?: Parameters<typeof validate>[1]
}>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeArgsFor<TDefinition>> {
  if (!definition.args) {
    return Object.freeze({}) as RealtimeArgsFor<TDefinition>
  }

  return await validate(input as Record<string, unknown>, definition.args) as RealtimeArgsFor<TDefinition>
}

export async function executeRealtimeQuery<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
): Promise<RealtimeExecutionResult<Awaited<TResult>>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  const db = getDatabaseContext()
  const args = await resolveArgs(definition, input)
  const auth = await authorize(definition.access, args, db)
  const result = await collectDatabaseQueryDependencies(async () => {
    return await definition.handler({
      args,
      auth: auth as never,
      db,
      name: definition.name,
    })
  })

  return Object.freeze({
    name: definition.name,
    data: result.value as RealtimeResultFor<TDefinition>,
    dependencies: result.dependencies,
  })
}

export async function executeRealtimeMutation<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeMutationDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
): Promise<RealtimeExecutionResult<Awaited<TResult>>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  const db = getDatabaseContext()
  const args = await resolveArgs(definition, input)
  const auth = await authorize(definition.access, args, db)
  const data = await definition.handler({
    args,
    auth: auth as never,
    db,
    name: definition.name,
  })

  return Object.freeze({
    name: definition.name,
    data: data as RealtimeResultFor<TDefinition>,
    dependencies: Object.freeze([]),
  })
}

function ensureDatabaseSubscription(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase ??= onDatabaseDependencyInvalidated(handleDatabaseInvalidation)
}

function dependenciesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right)
  return left.some(dependency => rightSet.has(dependency))
}

async function refreshSubscription<TDefinition extends RealtimeQueryDefinitionMetadata>(
  subscription: ActiveSubscription<TDefinition>,
): Promise<void> {
  try {
    const result = await executeRealtimeQuery(subscription.definition, subscription.args)
    subscription.dependencies = result.dependencies
    subscription.version += 1
    subscription.current = Object.freeze({
      ...result,
      version: subscription.version,
    })
    await subscription.options.onData?.(subscription.current)
  } catch (error) {
    await subscription.options.onError?.(error)
  }
}

async function handleDatabaseInvalidation(event: DatabaseDependencyInvalidationEvent): Promise<void> {
  const subscriptions = [...getRuntimeState().subscriptions.values()]
    .filter(subscription => dependenciesOverlap(subscription.dependencies, event.dependencies))

  await Promise.all(subscriptions.map(subscription => refreshSubscription(subscription)))
}

export async function subscribeRealtimeQuery<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
  options?: RealtimeSubscribeOptions<Awaited<TResult>>,
): Promise<RealtimeSubscription<Awaited<TResult>>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>,
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>> = {},
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>> {
  ensureDatabaseSubscription()
  const state = getRuntimeState()
  state.nextSubscriptionId += 1
  const result = await executeRealtimeQuery(definition, input)
  const snapshot = Object.freeze({
    ...result,
    version: 1,
  })
  const subscription: ActiveSubscription<TDefinition> = {
    id: `subscription.${state.nextSubscriptionId}`,
    definition,
    args: await resolveArgs(definition, input),
    options,
    dependencies: result.dependencies,
    version: 1,
    current: snapshot,
  }
  state.subscriptions.set(subscription.id, subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
  await options.onData?.(snapshot)

  return Object.freeze({
    id: subscription.id,
    name: definition.name,
    get current() {
      return subscription.current
    },
    unsubscribe() {
      getRuntimeState().subscriptions.delete(subscription.id)
    },
  })
}

export function configureRealtimeRuntime(bindings?: RealtimeRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function resetRealtimeRuntime(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase?.()
  state.bindings = undefined
  state.nextDefinitionId = 0
  state.nextSubscriptionId = 0
  state.unsubscribeFromDatabase = undefined
  state.subscriptions.clear()
}

export const realtimeRuntimeInternals = {
  REALTIME_DEFINITION_MARKER,
  createRealtimeDatabaseContext,
  getRuntimeState,
  handleDatabaseInvalidation,
  nextDefinitionName,
}

export { markDefinition, nextDefinitionName }
