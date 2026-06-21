import {
  DB,
  TableQueryBuilder,
  collectDatabaseQueryDependencies,
  onDatabaseDependencyInvalidated,
  serializeModels,
  type DatabaseContext,
  type DatabaseDependencyInvalidationEvent,
} from '@holo-js/db'
import { validate } from '@holo-js/validation'
import type { ValidationSchema } from '@holo-js/validation'
import {
  isRealtimeDefinition,
  nextDefinitionName,
  realtimeDefinitionInternals,
} from './definition'
import type {
  RealtimeAccess,
  RealtimeAccessObject,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeAuthModule,
  RealtimeAuthState,
  RealtimeDatabaseContext,
  RealtimeExecutionResult,
  RealtimeExecutionOptions,
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

type RuntimeState = {
  bindings?: RealtimeRuntimeBindings
  dependencySubscribers: Map<string, Set<string>>
  invalidationBatch?: PendingInvalidationBatch
  nextSubscriptionId: number
  refreshGroups: Map<string, Set<string>>
  refreshes: Map<string, ActiveRefresh>
  unsubscribeFromDatabase?: () => void
  subscriptions: Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>
}

type PendingInvalidationBatch = {
  readonly dependencies: Set<string>
  readonly deferred: Deferred<void>
  readonly events: DatabaseDependencyInvalidationEvent[]
  timer: ReturnType<typeof setTimeout>
}

type Deferred<TValue> = {
  readonly promise: Promise<TValue>
  resolve(value: TValue): void
  reject(error: unknown): void
}

type ActiveRefresh = {
  pending: boolean
  running?: Promise<void>
}

type ActiveSubscription<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly id: string
  readonly refreshKey: string
  readonly definition: TDefinition
  readonly args: RealtimeArgsFor<TDefinition>
  readonly options: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>
  readonly executionOptions?: RealtimeExecutionOptions
  dependencies: readonly string[]
  predicateDependencies: PredicateDependencyIndex
  resultHash: string
  version: number
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
}

type RefreshDelivery<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly result: RealtimeExecutionResult<RealtimeResultFor<TDefinition>>
  readonly resultHash: string
  predicateDependencies?: PredicateDependencyIndex
}

type ParsedPredicateDependency = {
  readonly tableKey: string
  readonly columnName: string
  readonly encodedValue: string
}

type PredicateDependencyIndex = Map<string, Map<string, Set<string>>>

type ParsedInvalidationEvent = {
  readonly dependencies: readonly string[]
  readonly exactPredicates: PredicateDependencyIndex
  readonly hasMutationDependency: boolean
  readonly predicates: PredicateDependencyIndex
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

  const state = runtime.__holoRealtimeRuntime__ ??= {
    dependencySubscribers: new Map<string, Set<string>>(),
    nextSubscriptionId: 0,
    refreshGroups: new Map<string, Set<string>>(),
    refreshes: new Map<string, ActiveRefresh>(),
    subscriptions: new Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>(),
  }
  state.dependencySubscribers ??= new Map<string, Set<string>>()
  state.refreshGroups ??= new Map<string, Set<string>>()
  return state
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve: (value: TValue) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return {
    promise,
    resolve,
    reject,
  }
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`
}

function createRefreshKey(
  definition: RealtimeQueryDefinitionMetadata,
  args: Record<string, unknown>,
  subscriptionId: string,
  executionOptions: RealtimeExecutionOptions | undefined,
): string {
  if (executionOptions) {
    return subscriptionId
  }

  return `${definition.name}:${stableStringify(args)}`
}

function createResultHash(value: unknown): string {
  return stableStringify(value)
}

function parsePredicateDependency(dependency: string): ParsedPredicateDependency | undefined {
  const match = dependency.match(/^(db:[^:]+:[^:]+):where:([^:]+):(.+)$/)
  if (!match) {
    return undefined
  }

  const [, tableKey, columnName, encodedValue] = match
  return {
    tableKey: tableKey!,
    columnName: columnName!,
    encodedValue: encodedValue!,
  }
}

function parseExactPredicateDependency(dependency: string): ParsedPredicateDependency | undefined {
  const match = dependency.match(/^(db:[^:]+:[^:]+):where-exact:([^:]+):(.+)$/)
  if (!match) {
    return undefined
  }

  const [, tableKey, columnName, encodedValue] = match
  return {
    tableKey: tableKey!,
    columnName: columnName!,
    encodedValue: encodedValue!,
  }
}

function hasMutationDependency(dependencies: readonly string[]): boolean {
  return dependencies.some(dependency => /^db:[^:]+:[^:]+:mutation$/.test(dependency))
}

function collectPredicateDependencies(
  dependencies: readonly string[],
  parseDependency: (dependency: string) => ParsedPredicateDependency | undefined = parsePredicateDependency,
): PredicateDependencyIndex {
  const predicates: PredicateDependencyIndex = new Map<string, Map<string, Set<string>>>()
  for (const dependency of dependencies) {
    const parsed = parseDependency(dependency)
    if (!parsed) {
      continue
    }

    const tablePredicates = predicates.get(parsed.tableKey) ?? new Map<string, Set<string>>()
    const values = tablePredicates.get(parsed.columnName) ?? new Set<string>()
    values.add(parsed.encodedValue)
    tablePredicates.set(parsed.columnName, values)
    predicates.set(parsed.tableKey, tablePredicates)
  }

  return predicates
}

function parseInvalidationEvent(event: DatabaseDependencyInvalidationEvent): ParsedInvalidationEvent {
  return {
    dependencies: event.dependencies,
    exactPredicates: collectPredicateDependencies(event.dependencies, parseExactPredicateDependency),
    hasMutationDependency: hasMutationDependency(event.dependencies),
    predicates: collectPredicateDependencies(event.dependencies),
  }
}

function isSubscriptionContradictedByInvalidation(
  subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>,
  event: ParsedInvalidationEvent,
): boolean {
  if (
    subscription.predicateDependencies.size === 0
    || event.predicates.size === 0
    || event.exactPredicates.size === 0
    || event.hasMutationDependency
  ) {
    return false
  }

  for (const [tableKey, tablePredicates] of subscription.predicateDependencies) {
    for (const [columnName, values] of tablePredicates) {
      const invalidatedValues = event.predicates.get(tableKey)?.get(columnName)
      const exactInvalidatedValues = event.exactPredicates.get(tableKey)?.get(columnName)
      for (const value of values) {
        if (invalidatedValues?.has(value)) {
          continue
        }

        if (exactInvalidatedValues && !exactInvalidatedValues.has(value)) {
          return true
        }
      }
    }
  }

  return false
}

function createRealtimeDatabaseContext(connection: DatabaseContext): RealtimeDatabaseContext {
  const context = {
    connection,
    table(table: string) {
      return new TableQueryBuilder(table, connection)
    },
    model(...parameters: Parameters<DatabaseContext['model']>) {
      return connection.model(...parameters)
    },
  } satisfies RealtimeDatabaseContext

  return Object.freeze(context)
}

function getDatabaseContext(): RealtimeDatabaseContext {
  return createRealtimeDatabaseContext(getRuntimeState().bindings?.db?.() ?? DB.connection())
}

async function runWithExecutionOptions<TResult>(
  options: RealtimeExecutionOptions | undefined,
  callback: () => Promise<TResult>,
): Promise<TResult> {
  if (options?.authRequest) {
    const runner = getRuntimeState().bindings?.runWithAuthRequestAccessors
    if (runner) {
      return await runner(options.authRequest, callback)
    }
  }

  return await callback()
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
      auth,
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
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<TResult>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  return await runWithExecutionOptions(options, async () => {
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
      data: serializeModels(result.value) as RealtimeResultFor<TDefinition>,
      dependencies: result.dependencies,
    })
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
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<TResult>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  return await runWithExecutionOptions(options, async () => {
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
      data: serializeModels(data) as RealtimeResultFor<TDefinition>,
      dependencies: Object.freeze([]),
    })
  })
}

function ensureDatabaseSubscription(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase ??= onDatabaseDependencyInvalidated(handleBatchedDatabaseInvalidation)
}

function addSubscriptionDependencies(subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const dependency of subscription.dependencies) {
    const subscribers = state.dependencySubscribers.get(dependency) ?? new Set<string>()
    subscribers.add(subscription.id)
    state.dependencySubscribers.set(dependency, subscribers)
  }
}

function addSubscriptionRefreshGroup(subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  const group = state.refreshGroups.get(subscription.refreshKey) ?? new Set<string>()
  group.add(subscription.id)
  state.refreshGroups.set(subscription.refreshKey, group)
}

function removeSubscriptionDependencies(subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const dependency of subscription.dependencies) {
    const subscribers = state.dependencySubscribers.get(dependency)
    if (!subscribers) {
      continue
    }

    subscribers.delete(subscription.id)
    if (subscribers.size === 0) {
      state.dependencySubscribers.delete(dependency)
    }
  }
}

function removeSubscriptionRefreshGroup(subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  const group = state.refreshGroups.get(subscription.refreshKey)
  if (!group) {
    return
  }

  group.delete(subscription.id)
  if (group.size === 0) {
    state.refreshGroups.delete(subscription.refreshKey)
  }
}

function areDependencySetsEqual(
  currentDependencies: readonly string[],
  nextDependencies: readonly string[],
): boolean {
  if (currentDependencies === nextDependencies) {
    return true
  }

  if (currentDependencies.length !== nextDependencies.length) {
    return false
  }

  for (let index = 0; index < currentDependencies.length; index += 1) {
    if (currentDependencies[index] !== nextDependencies[index]) {
      const currentDependencySet = new Set(currentDependencies)
      if (currentDependencySet.size !== nextDependencies.length) {
        return false
      }

      return nextDependencies.every(dependency => currentDependencySet.has(dependency))
    }
  }

  return true
}

function updateSubscriptionDependencies(
  subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>,
  dependencies: readonly string[],
  predicateDependencies?: PredicateDependencyIndex,
): void {
  if (areDependencySetsEqual(subscription.dependencies, dependencies)) {
    return
  }

  removeSubscriptionDependencies(subscription)
  subscription.dependencies = dependencies
  subscription.predicateDependencies = predicateDependencies ?? collectPredicateDependencies(dependencies)
  addSubscriptionDependencies(subscription)
}

function ensureRefreshDeliveryPredicateDependencies<TDefinition extends RealtimeQueryDefinitionMetadata>(
  delivery: RefreshDelivery<TDefinition>,
): PredicateDependencyIndex {
  delivery.predicateDependencies ??= collectPredicateDependencies(delivery.result.dependencies)
  return delivery.predicateDependencies
}

function deleteSubscription(subscriptionId: string): void {
  const state = getRuntimeState()
  const subscription = state.subscriptions.get(subscriptionId)
  if (!subscription) {
    return
  }

  removeSubscriptionDependencies(subscription)
  removeSubscriptionRefreshGroup(subscription)
  state.subscriptions.delete(subscriptionId)
}

function getSubscriptionsForDependencies(dependencies: Iterable<string>): ActiveSubscription<RealtimeQueryDefinitionMetadata>[] {
  const state = getRuntimeState()
  const subscriptionIds = new Set<string>()
  for (const dependency of dependencies) {
    for (const subscriptionId of state.dependencySubscribers.get(dependency) ?? []) {
      subscriptionIds.add(subscriptionId)
    }
  }

  return [...subscriptionIds]
    .map(subscriptionId => state.subscriptions.get(subscriptionId))
    .filter(subscription => typeof subscription !== 'undefined')
}

function getRefreshGroupSubscriptions(refreshKey: string): ActiveSubscription<RealtimeQueryDefinitionMetadata>[] {
  const state = getRuntimeState()
  return [...state.refreshGroups.get(refreshKey) ?? []]
    .map(subscriptionId => state.subscriptions.get(subscriptionId))
    .filter(subscription => typeof subscription !== 'undefined')
}

async function deliverRefreshData<TDefinition extends RealtimeQueryDefinitionMetadata>(
  subscription: ActiveSubscription<TDefinition>,
  delivery: RefreshDelivery<TDefinition>,
): Promise<void> {
  const predicateDependencies = areDependencySetsEqual(subscription.dependencies, delivery.result.dependencies)
    ? undefined
    : ensureRefreshDeliveryPredicateDependencies(delivery)
  updateSubscriptionDependencies(
    subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>,
    delivery.result.dependencies,
    predicateDependencies,
  )
  if (subscription.resultHash === delivery.resultHash) {
    return
  }

  subscription.resultHash = delivery.resultHash
  subscription.version += 1
  subscription.current = Object.freeze({
    ...delivery.result,
    version: subscription.version,
  })
  try {
    await subscription.options.onData?.(subscription.current)
  } catch (error) {
    console.error('[@holo-js/realtime] Realtime subscription onData callback failed.', error)
  }
}

async function deliverRefreshError(
  subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>,
  error: unknown,
): Promise<void> {
  try {
    await subscription.options.onError?.(error)
  } catch (handlerError) {
    console.error('[@holo-js/realtime] Realtime subscription onError callback failed.', handlerError)
  }
}

async function refreshSubscriptionGroup(refreshKey: string): Promise<void> {
  const subscriptions = getRefreshGroupSubscriptions(refreshKey)
  const firstSubscription = subscriptions[0]
  if (!firstSubscription) {
    return
  }

  try {
    const result = await executeRealtimeQuery(
      firstSubscription.definition,
      firstSubscription.args,
      firstSubscription.executionOptions,
    )
    const delivery = {
      result,
      resultHash: createResultHash(result.data),
    } satisfies RefreshDelivery<typeof firstSubscription.definition>
    await Promise.all(getRefreshGroupSubscriptions(refreshKey).map(async (subscription) => {
      await deliverRefreshData(subscription, delivery)
    }))
  } catch (error) {
    await Promise.all(getRefreshGroupSubscriptions(refreshKey).map(async (subscription) => {
      await deliverRefreshError(subscription, error)
    }))
  }
}

async function drainRefresh(refreshKey: string, refresh: ActiveRefresh): Promise<void> {
  try {
    do {
      refresh.pending = false
      await refreshSubscriptionGroup(refreshKey)
    } while (refresh.pending)
  } finally {
    refresh.running = undefined
    if (!refresh.pending) {
      getRuntimeState().refreshes.delete(refreshKey)
    }
  }
}

function scheduleRefreshKey(refreshKey: string): Promise<void> {
  const state = getRuntimeState()
  const refresh = state.refreshes.get(refreshKey) ?? {
    pending: false,
  }
  state.refreshes.set(refreshKey, refresh)

  if (refresh.running) {
    refresh.pending = true
    return refresh.running
  }

  refresh.running = drainRefresh(refreshKey, refresh)
  return refresh.running
}

function scheduleSubscriptionRefresh(subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>): Promise<void> {
  return scheduleRefreshKey(subscription.refreshKey)
}

async function handleDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEvent,
  events: readonly DatabaseDependencyInvalidationEvent[] = [event],
): Promise<void> {
  const parsedEvents = events.map(parseInvalidationEvent)
  const subscriptions = getSubscriptionsForDependencies(event.dependencies)
    .filter(subscription => parsedEvents.some(candidate => !isSubscriptionContradictedByInvalidation(subscription, candidate)))
  const refreshKeys = new Set(subscriptions.map(subscription => subscription.refreshKey))
  await Promise.all([...refreshKeys].map(async (refreshKey) => {
    await scheduleRefreshKey(refreshKey)
  }))
}

async function flushInvalidationBatch(batch: PendingInvalidationBatch): Promise<void> {
  const state = getRuntimeState()
  if (state.invalidationBatch === batch) {
    state.invalidationBatch = undefined
  }

  try {
    await handleDatabaseInvalidation({
      connectionName: '',
      dependencies: [...batch.dependencies],
    }, batch.events)
    batch.deferred.resolve(undefined)
  } catch (error) {
    batch.deferred.reject(error)
  }
}

async function handleBatchedDatabaseInvalidation(event: DatabaseDependencyInvalidationEvent): Promise<void> {
  const state = getRuntimeState()
  const batch = state.invalidationBatch
  if (batch) {
    for (const dependency of event.dependencies) {
      batch.dependencies.add(dependency)
    }
    batch.events.push(event)

    return await batch.deferred.promise
  }

  const deferred = createDeferred<void>()
  const nextBatch: PendingInvalidationBatch = {
    dependencies: new Set(event.dependencies),
    deferred,
    events: [event],
    timer: setTimeout(() => {
      void flushInvalidationBatch(nextBatch)
    }, 10),
  }
  state.invalidationBatch = nextBatch
  return await deferred.promise
}

export async function subscribeRealtimeQuery<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
  options?: RealtimeSubscribeOptions<TResult>,
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<TResult>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>,
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>> = {},
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>> {
  ensureDatabaseSubscription()
  const state = getRuntimeState()
  state.nextSubscriptionId += 1
  const args = await resolveArgs(definition, input)
  const id = `subscription.${state.nextSubscriptionId}`
  const result = await executeRealtimeQuery(definition, args, executionOptions)
  const snapshot = Object.freeze({
    ...result,
    version: 1,
  })
  const resultHash = createResultHash(result.data)
  const subscription: ActiveSubscription<TDefinition> = {
    id,
    refreshKey: createRefreshKey(
      definition,
      args as Record<string, unknown>,
      id,
      executionOptions,
    ),
    definition,
    args,
    options,
    executionOptions,
    dependencies: result.dependencies,
    predicateDependencies: collectPredicateDependencies(result.dependencies),
    resultHash,
    version: 1,
    current: snapshot,
  }
  state.subscriptions.set(subscription.id, subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
  addSubscriptionDependencies(subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
  addSubscriptionRefreshGroup(subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
  await options.onData?.(snapshot)

  return Object.freeze({
    id: subscription.id,
    name: definition.name,
    get current() {
      return subscription.current
    },
    unsubscribe() {
      deleteSubscription(subscription.id)
    },
  })
}

export function configureRealtimeRuntime(bindings?: RealtimeRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function resetRealtimeRuntime(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase?.()
  if (state.invalidationBatch) {
    clearTimeout(state.invalidationBatch.timer)
    state.invalidationBatch.deferred.resolve(undefined)
  }
  state.bindings = undefined
  state.dependencySubscribers.clear()
  state.invalidationBatch = undefined
  state.nextSubscriptionId = 0
  state.refreshGroups.clear()
  state.unsubscribeFromDatabase = undefined
  state.refreshes.clear()
  state.subscriptions.clear()
}

export const realtimeRuntimeInternals = {
  REALTIME_DEFINITION_MARKER: realtimeDefinitionInternals.REALTIME_DEFINITION_MARKER,
  createRealtimeDatabaseContext,
  createRefreshKey,
  getRuntimeState,
  handleBatchedDatabaseInvalidation,
  handleDatabaseInvalidation,
  nextDefinitionName,
  scheduleSubscriptionRefresh,
  stableStringify,
}

export { isRealtimeDefinition, nextDefinitionName }
