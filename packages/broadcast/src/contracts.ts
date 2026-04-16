import type { NormalizedHoloBroadcastConfig } from '@holo-js/config'
import type { InferSchemaData, ValidationSchema } from '@holo-js/validation'

const HOLO_BROADCAST_DEFINITION_MARKER = Symbol.for('holo-js.broadcast.definition')
const HOLO_CHANNEL_DEFINITION_MARKER = Symbol.for('holo-js.broadcast.channel')

export type BroadcastJsonPrimitive = string | number | boolean | null
export type BroadcastJsonValue = BroadcastJsonPrimitive | readonly BroadcastJsonValue[] | BroadcastJsonObject
export type BroadcastJsonObject = {
  readonly [key: string]: BroadcastJsonValue
}

export type BroadcastChannelType = 'public' | 'private' | 'presence'
export type BroadcastDelayValue = number | Date

type ExtractChannelPatternParamNames<TPattern extends string>
  = TPattern extends `${string}{${infer TParam}}${infer TRest}`
    ? TParam | ExtractChannelPatternParamNames<TRest>
    : never

export type ChannelPatternParams<TPattern extends string>
  = [ExtractChannelPatternParamNames<TPattern>] extends [never]
    ? Record<string, never>
    : Readonly<Record<ExtractChannelPatternParamNames<TPattern>, string>>

export interface BroadcastTargetParamInput {
  readonly [key: string]: string | number | boolean | null | undefined
}

export interface BroadcastChannelTarget<
  TType extends BroadcastChannelType = BroadcastChannelType,
  TPattern extends string = string,
  TParams extends Record<string, string> = Record<string, string>,
> {
  readonly type: TType
  readonly pattern: TPattern
  readonly params: Readonly<TParams>
}

export interface BroadcastQueueOptions {
  readonly queued?: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit?: boolean
}

export interface NormalizedBroadcastQueueOptions {
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit: boolean
}

export interface BroadcastDefinitionInput<
  TName extends string = string,
  TPayload extends BroadcastJsonObject = BroadcastJsonObject,
  TChannels extends readonly BroadcastChannelTarget[] = readonly BroadcastChannelTarget[],
> {
  readonly name?: TName
  readonly channels?: TChannels | (() => TChannels)
  readonly payload?: TPayload | (() => TPayload)
  readonly queue?: boolean | BroadcastQueueOptions
  readonly delay?: BroadcastDelayValue
}

export interface BroadcastDefinition<
  TName extends string = string,
  TPayload extends BroadcastJsonObject = BroadcastJsonObject,
  TChannels extends readonly BroadcastChannelTarget[] = readonly BroadcastChannelTarget[],
> {
  readonly name?: TName
  readonly channels: Readonly<TChannels>
  readonly payload: Readonly<TPayload>
  readonly queue: NormalizedBroadcastQueueOptions
  readonly delay?: BroadcastDelayValue
}

export type ExportedBroadcastDefinition<TValue>
  = Extract<TValue, BroadcastDefinition> extends never
    ? BroadcastDefinition
    : Extract<TValue, BroadcastDefinition>

export type BroadcastAuthorizeResult<TType extends BroadcastChannelType, TPresenceMember extends BroadcastJsonObject>
  = TType extends 'presence'
    ? false | TPresenceMember
    : boolean

export type BroadcastWhisperSchema = ValidationSchema
export type BroadcastWhisperDefinitions = Readonly<Record<string, BroadcastWhisperSchema>>
export type InferBroadcastWhisperPayload<TSchema> = TSchema extends { readonly $data?: infer TData } ? TData : never

export interface ChannelDefinitionInput<
  TPattern extends string = string,
  TType extends Extract<BroadcastChannelType, 'private' | 'presence'> = Extract<BroadcastChannelType, 'private' | 'presence'>,
  TUser = unknown,
  TPresenceMember extends BroadcastJsonObject = BroadcastJsonObject,
  TWhispers extends BroadcastWhisperDefinitions = BroadcastWhisperDefinitions,
> {
  readonly type: TType
  readonly authorize: (
    user: TUser,
    params: ChannelPatternParams<TPattern>,
  ) => BroadcastAuthorizeResult<TType, TPresenceMember> | Promise<BroadcastAuthorizeResult<TType, TPresenceMember>>
  readonly whispers?: TWhispers
}

export interface ChannelDefinition<
  TPattern extends string = string,
  TType extends Extract<BroadcastChannelType, 'private' | 'presence'> = Extract<BroadcastChannelType, 'private' | 'presence'>,
  TUser = unknown,
  TPresenceMember extends BroadcastJsonObject = BroadcastJsonObject,
  TWhispers extends BroadcastWhisperDefinitions = BroadcastWhisperDefinitions,
> {
  readonly pattern: TPattern
  readonly type: TType
  readonly authorize: ChannelDefinitionInput<TPattern, TType, TUser, TPresenceMember, TWhispers>['authorize']
  readonly whispers: Readonly<TWhispers>
}

export type ExportedChannelDefinition<TValue>
  = Extract<TValue, ChannelDefinition> extends never
    ? ChannelDefinition
    : Extract<TValue, ChannelDefinition>

export interface RawBroadcastSendInput<TPayload extends BroadcastJsonObject = BroadcastJsonObject> {
  readonly connection?: string
  readonly event: string
  readonly channels: readonly string[]
  readonly payload: Readonly<TPayload>
  readonly socketId?: string
}

export interface ResolvedRawBroadcastSendInput<TPayload extends BroadcastJsonObject = BroadcastJsonObject> {
  readonly connection: string
  readonly event: string
  readonly channels: readonly string[]
  readonly payload: Readonly<TPayload>
  readonly socketId?: string
}

export interface BroadcastSendResult {
  readonly connection: string
  readonly driver: string
  readonly queued: boolean
  readonly publishedChannels: readonly string[]
  readonly messageId?: string
  readonly provider?: Readonly<Record<string, unknown>>
}

export interface BroadcastDispatchOptions {
  readonly broadcaster?: string
  readonly connection?: string
  readonly queue?: string
  readonly delay?: BroadcastDelayValue
  readonly afterCommit?: boolean
}

export interface BroadcastSendInput {
  readonly broadcast: BroadcastDefinition
  readonly raw: ResolvedRawBroadcastSendInput
  readonly options: Readonly<BroadcastDispatchOptions>
}

export interface BroadcastRuntimeBindings {
  readonly config?: NormalizedHoloBroadcastConfig
  publish?(
    input: ResolvedRawBroadcastSendInput,
    context: BroadcastDriverExecutionContext,
  ): BroadcastSendResult | Promise<BroadcastSendResult>
  readonly channelAuth?: BroadcastChannelAuthRuntimeBindings
}

export interface BroadcastRuntimeFacade {
  broadcast(
    definition: BroadcastDefinition | BroadcastDefinitionInput,
  ): PendingBroadcastDispatch<BroadcastSendResult>
  broadcastRaw(
    input: RawBroadcastSendInput,
  ): PendingBroadcastDispatch<BroadcastSendResult>
}

export interface PendingBroadcastDispatch<TResult = BroadcastSendResult> extends PromiseLike<TResult> {
  using(name: string): PendingBroadcastDispatch<TResult>
  onConnection(name: string): PendingBroadcastDispatch<TResult>
  onQueue(name: string): PendingBroadcastDispatch<TResult>
  delay(value: BroadcastDelayValue): PendingBroadcastDispatch<TResult>
  afterCommit(): PendingBroadcastDispatch<TResult>
  then<TResult1 = TResult, TResult2 = never>(
    onfulfilled?: ((value: TResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult | TResult1>
  finally(onfinally?: (() => void) | null): Promise<TResult>
}

export interface BroadcastDriverExecutionContext {
  readonly connection: string
  readonly driver: string
  readonly queued: boolean
  readonly delayed: boolean
}

export interface BroadcastDriver {
  send(
    input: ResolvedRawBroadcastSendInput,
    context: BroadcastDriverExecutionContext,
  ): BroadcastSendResult | Promise<BroadcastSendResult>
}

export interface RegisterBroadcastDriverOptions {
  readonly replace?: boolean
}

export interface RegisteredBroadcastDriver {
  readonly name: string
  readonly driver: BroadcastDriver
}

export interface BuiltInBroadcastDriverRegistry {
  readonly holo: BroadcastDriver
  readonly pusher: BroadcastDriver
  readonly ably: BroadcastDriver
  readonly log: BroadcastDriver
  readonly null: BroadcastDriver
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloBroadcastDriverRegistry {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloBroadcastRegistry {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloChannelRegistry {}

export type BroadcastDriverName
  = keyof BuiltInBroadcastDriverRegistry
  | keyof HoloBroadcastDriverRegistry
  | (string & {})

export interface GeneratedChannelAuthRegistryEntry {
  readonly sourcePath: string
  readonly pattern: string
  readonly exportName?: string
  readonly type: 'private' | 'presence'
  readonly params: readonly string[]
  readonly whispers: readonly string[]
}

export interface BroadcastChannelAuthRuntimeBindings {
  readonly definitions?: Readonly<Record<string, ChannelDefinition>> | readonly ChannelDefinition[]
  readonly registry?: {
    readonly projectRoot: string
    readonly channels: readonly GeneratedChannelAuthRegistryEntry[]
  }
  readonly resolveUser?: (connection: {
    readonly headers: Headers
    readonly socketId: string
    readonly channel: string
    readonly appId: string
    readonly connection: string
  }) => unknown | Promise<unknown>
  readonly importModule?: (absolutePath: string) => Promise<unknown>
}

export interface BroadcastChannelAuthRequest {
  readonly channel: string
  readonly socketId?: string
  readonly user: unknown
}

export interface BroadcastChannelAuthSuccess {
  readonly ok: true
  readonly channel: string
  readonly type: 'private' | 'presence'
  readonly pattern: string
  readonly params: Readonly<Record<string, string>>
  readonly whispers: readonly string[]
  readonly member?: Readonly<BroadcastJsonObject>
}

export interface BroadcastChannelAuthFailure {
  readonly ok: false
  readonly channel: string
  readonly code: 'unauthorized' | 'not-found'
}

export type BroadcastChannelAuthResult = BroadcastChannelAuthSuccess | BroadcastChannelAuthFailure

export interface BroadcastAuthEndpointPayload {
  readonly channel: string
  readonly socketId?: string
}

export interface BroadcastAuthEndpointSuccessBody {
  readonly ok: true
  readonly channel: string
  readonly type: 'private' | 'presence'
  readonly params: Readonly<Record<string, string>>
  readonly whispers: readonly string[]
  readonly member?: Readonly<BroadcastJsonObject>
}

export interface BroadcastAuthEndpointErrorBody {
  readonly ok: false
  readonly error: 'invalid-request' | 'unauthenticated' | 'not-found' | 'unauthorized' | 'method-not-allowed'
  readonly message: string
}

export type BroadcastAuthEndpointBody = BroadcastAuthEndpointSuccessBody | BroadcastAuthEndpointErrorBody

export interface BroadcastAuthEndpointOptions {
  readonly user?: unknown
  readonly resolveUser?: (request: Request) => unknown | Promise<unknown>
  readonly channelAuth?: BroadcastChannelAuthRuntimeBindings
}

export interface BroadcastWhisperValidationResult<TPayload extends BroadcastJsonObject = BroadcastJsonObject> {
  readonly channel: string
  readonly event: string
  readonly payload: Readonly<TPayload>
}

type KnownBroadcastName = Extract<keyof HoloBroadcastRegistry, string>
type KnownChannelPattern = Extract<keyof HoloChannelRegistry, string>

export type BroadcastPayloadFor<TName extends string>
  = TName extends KnownBroadcastName
    ? HoloBroadcastRegistry[TName] extends BroadcastDefinition<string, infer TPayload, readonly BroadcastChannelTarget[]>
      ? TPayload
      : BroadcastJsonObject
    : BroadcastJsonObject

export type BroadcastChannelsFor<TName extends string>
  = TName extends KnownBroadcastName
    ? HoloBroadcastRegistry[TName] extends BroadcastDefinition<string, BroadcastJsonObject, infer TChannels>
      ? TChannels
      : readonly BroadcastChannelTarget[]
    : readonly BroadcastChannelTarget[]

export type ChannelDefinitionFor<TPattern extends string>
  = TPattern extends KnownChannelPattern
    ? HoloChannelRegistry[TPattern] extends ChannelDefinition
      ? HoloChannelRegistry[TPattern]
      : ChannelDefinition
    : ChannelDefinition

export type ChannelPresenceMemberFor<TPattern extends string>
  = ChannelDefinitionFor<TPattern> extends ChannelDefinition<string, 'presence', unknown, infer TPresenceMember, BroadcastWhisperDefinitions>
    ? TPresenceMember
    : never

export type ChannelWhisperPayloadFor<
  TPattern extends string,
  TName extends string,
> = ChannelDefinitionFor<TPattern> extends ChannelDefinition<string, Extract<BroadcastChannelType, 'private' | 'presence'>, unknown, BroadcastJsonObject, infer TWhispers>
  ? TName extends keyof TWhispers
    ? InferBroadcastWhisperPayload<TWhispers[TName]>
    : never
  : never

export interface GeneratedBroadcastManifestEvent {
  readonly name: string
  readonly channels: readonly {
    readonly type: BroadcastChannelType
    readonly pattern: string
  }[]
}

export interface GeneratedBroadcastManifestChannel {
  readonly name: string
  readonly pattern: string
  readonly type: Extract<BroadcastChannelType, 'private' | 'presence'>
  readonly params: readonly string[]
  readonly whispers: readonly string[]
  readonly member?: Readonly<BroadcastJsonObject>
}

export interface GeneratedBroadcastManifest {
  readonly version: 1
  readonly generatedAt: string
  readonly events: readonly GeneratedBroadcastManifestEvent[]
  readonly channels: readonly GeneratedBroadcastManifestChannel[]
}

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function normalizeOptionalString(value: string | undefined, label: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Broadcast] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeDelayValue(value: BroadcastDelayValue | undefined): BroadcastDelayValue | undefined {
  /* v8 ignore next 3 -- explicit undefined input is normalized away by caller usage in practice */
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('[Holo Broadcast] Broadcast delay must be a finite number greater than or equal to 0.')
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('[Holo Broadcast] Broadcast delay dates must be valid Date instances.')
  }

  return value
}

function normalizeJsonValue(value: unknown, path: string): BroadcastJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => normalizeJsonValue(entry, `${path}[${index}]`)))
  }

  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (!key.trim()) {
          throw new Error(`[Holo Broadcast] ${path} must not include empty payload keys.`)
        }

        return [key, normalizeJsonValue(entry, `${path}.${key}`)] as const
      }),
    ))
  }

  throw new Error(`[Holo Broadcast] ${path} must be JSON-serializable.`)
}

function normalizePayload<TPayload extends BroadcastJsonObject>(
  payload: TPayload | (() => TPayload) | undefined,
): Readonly<TPayload> {
  const resolved = typeof payload === 'function'
    ? (payload as () => TPayload)()
    : payload

  if (!isPlainObject(resolved)) {
    throw new Error('[Holo Broadcast] Broadcast payload must be a plain object.')
  }

  return normalizeJsonValue(resolved, 'Broadcast payload') as Readonly<TPayload>
}

function normalizeQueueOptions(queue: boolean | BroadcastQueueOptions | undefined): NormalizedBroadcastQueueOptions {
  if (typeof queue === 'boolean' || typeof queue === 'undefined') {
    return Object.freeze({
      queued: queue === true,
      afterCommit: false,
    })
  }

  const connection = normalizeOptionalString(queue.connection, 'Broadcast queue connection')
  const queueName = normalizeOptionalString(queue.queue, 'Broadcast queue name')
  const afterCommit = queue.afterCommit === true
  const queued = queue.queued === true

  if (!queued && (connection || queueName || afterCommit)) {
    throw new Error('[Holo Broadcast] Broadcast queue metadata requires queued: true.')
  }

  return Object.freeze({
    queued,
    ...(typeof connection === 'undefined' ? {} : { connection }),
    ...(typeof queueName === 'undefined' ? {} : { queue: queueName }),
    afterCommit,
  })
}

function normalizePatternSegment(segment: string, label: string): string {
  if (!segment) {
    throw new Error(`[Holo Broadcast] ${label} must not contain empty path segments.`)
  }

  const wildcardMatch = segment.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (wildcardMatch) {
    return wildcardMatch[1]!
  }

  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`[Holo Broadcast] ${label} contains invalid segment "${segment}".`)
  }

  return segment
}

export function extractChannelPatternParamNames(pattern: string): readonly string[] {
  const normalized = normalizeChannelPattern(pattern, 'Channel pattern')
  const params = normalized
    .split('.')
    .map(segment => segment.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1])
    .filter((value): value is string => typeof value === 'string')

  const duplicates = params.filter((param, index) => params.indexOf(param) !== index)
  if (duplicates.length > 0) {
    throw new Error(`[Holo Broadcast] Channel pattern "${normalized}" contains duplicate params.`)
  }

  return Object.freeze(params)
}

export function normalizeChannelPattern(pattern: string, label = 'Channel pattern'): string {
  const normalized = normalizeOptionalString(pattern, label)
    /* v8 ignore next -- normalizeOptionalString already rejects empty pattern values */
    ?? (() => { throw new Error(`[Holo Broadcast] ${label} must be a non-empty string.`) })()

  // Validate each segment without changing the pattern
  normalized.split('.').forEach(segment => normalizePatternSegment(segment, label))
  return normalized
}

function normalizeTargetParams<TPattern extends string>(
  pattern: TPattern,
  params: BroadcastTargetParamInput | undefined,
): ChannelPatternParams<TPattern> {
  const expectedParams = extractChannelPatternParamNames(pattern)
  const providedEntries = Object.entries(params ?? {})
    .filter(([, value]) => typeof value !== 'undefined')
    .map(([key, value]) => {
      const normalizedKey = key.trim()
      if (!normalizedKey) {
        throw new Error('[Holo Broadcast] Channel target params must not include empty keys.')
      }

      return [normalizedKey, String(value)] as const
    })

  const provided = Object.freeze(Object.fromEntries(providedEntries)) as ChannelPatternParams<TPattern>
  const providedNames = Object.keys(provided)

  for (const param of expectedParams) {
    if (!(param in provided)) {
      throw new Error(`[Holo Broadcast] Channel target for "${pattern}" must define param "${param}".`)
    }
  }

  for (const param of providedNames) {
    if (!expectedParams.includes(param)) {
      throw new Error(`[Holo Broadcast] Channel target for "${pattern}" does not define param "${param}".`)
    }
  }

  return provided
}

export function formatChannelPattern<TPattern extends string>(
  pattern: TPattern,
  params: ChannelPatternParams<TPattern>,
): string {
  return normalizeChannelPattern(pattern).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const value = params[key as keyof typeof params]
    if (typeof value !== 'string') {
      throw new Error(`[Holo Broadcast] Channel target for "${pattern}" is missing param "${key}".`)
    }

    return value
  })
}

function createChannelTarget<TType extends BroadcastChannelType, TPattern extends string>(
  type: TType,
  pattern: TPattern,
  params?: BroadcastTargetParamInput,
): BroadcastChannelTarget<TType, TPattern> {
  const normalizedPattern = normalizeChannelPattern(pattern, 'Channel target pattern') as TPattern

  return Object.freeze({
    type,
    pattern: normalizedPattern,
    params: normalizeTargetParams(normalizedPattern, params),
  })
}

function normalizeChannels<TChannels extends readonly BroadcastChannelTarget[]>(
  input: TChannels | (() => TChannels) | undefined,
): Readonly<TChannels> {
  const resolved = typeof input === 'function'
    ? (input as () => TChannels)()
    : input

  if (!isReadonlyArray(resolved) || resolved.length === 0) {
    throw new Error('[Holo Broadcast] Broadcast definitions must target at least one channel.')
  }

  const normalizedChannels = resolved.map((channel, index) => {
    if (!isBroadcastChannelTarget(channel)) {
      throw new Error(`[Holo Broadcast] Broadcast channel at index ${index} must be created through channel helpers.`)
    }

    return Object.freeze({
      type: channel.type,
      pattern: normalizeChannelPattern(channel.pattern, `Broadcast channel ${index} pattern`),
      params: normalizeTargetParams(channel.pattern, channel.params),
    })
  })

  return Object.freeze(normalizedChannels) as unknown as Readonly<TChannels>
}

function normalizeWhisperDefinitions<TWhispers extends BroadcastWhisperDefinitions | undefined>(
  whispers: TWhispers,
): Readonly<TWhispers extends BroadcastWhisperDefinitions ? TWhispers : BroadcastWhisperDefinitions> {
  const entries = Object.entries(whispers ?? {})
  const normalizedEntries = entries.map(([name, schema]) => {
    const normalizedName = normalizeOptionalString(name, 'Whisper event name')
    /* v8 ignore next 3 -- normalizeOptionalString already rejects empty whisper names */
    if (!normalizedName) {
      throw new Error('[Holo Broadcast] Whisper event names must be non-empty strings.')
    }

    if (!schema || typeof schema !== 'object' || !('~standard' in schema)) {
      throw new Error(`[Holo Broadcast] Whisper "${normalizedName}" must be a validation schema.`)
    }

    return [normalizedName, schema] as const
  })

  return Object.freeze(Object.fromEntries(normalizedEntries)) as Readonly<TWhispers extends BroadcastWhisperDefinitions ? TWhispers : BroadcastWhisperDefinitions>
}

export function isBroadcastChannelTarget(value: unknown): value is BroadcastChannelTarget {
  return isPlainObject(value)
    && typeof value.pattern === 'string'
    && typeof value.type === 'string'
    && isPlainObject(value.params)
}

export function isBroadcastDefinition(value: unknown): value is BroadcastDefinition {
  return isPlainObject(value)
    && HOLO_BROADCAST_DEFINITION_MARKER in value
}

export function isChannelDefinition(value: unknown): value is ChannelDefinition {
  return isPlainObject(value)
    && HOLO_CHANNEL_DEFINITION_MARKER in value
}

export function normalizeBroadcastDefinition<
  TName extends string,
  TPayload extends BroadcastJsonObject,
  TChannels extends readonly BroadcastChannelTarget[],
>(
  definition: BroadcastDefinitionInput<TName, TPayload, TChannels>,
): BroadcastDefinition<TName, TPayload, TChannels> {
  if (!isPlainObject(definition)) {
    throw new Error('[Holo Broadcast] Broadcast definitions must be plain objects.')
  }

  const normalizedInput = definition as BroadcastDefinitionInput<TName, TPayload, TChannels>
  const name = normalizeOptionalString(normalizedInput.name, 'Broadcast name')
  const normalized = {
    ...(typeof name === 'undefined' ? {} : { name: name as TName }),
    channels: normalizeChannels(normalizedInput.channels),
    payload: normalizePayload(normalizedInput.payload),
    queue: normalizeQueueOptions(normalizedInput.queue),
    ...(typeof normalizedInput.delay === 'undefined' ? {} : { delay: normalizeDelayValue(normalizedInput.delay) }),
  } as BroadcastDefinition<TName, TPayload, TChannels>

  return normalized
}

export function defineBroadcast<
  TName extends string,
  TPayload extends BroadcastJsonObject,
  TChannels extends readonly BroadcastChannelTarget[],
>(
  definition: BroadcastDefinitionInput<TName, TPayload, TChannels>,
): BroadcastDefinition<TName, TPayload, TChannels> {
  const normalized = { ...normalizeBroadcastDefinition(definition) }
  Object.defineProperty(normalized, HOLO_BROADCAST_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })
  return Object.freeze(normalized)
}

export function normalizeChannelDefinition<
  TPattern extends string,
  TType extends Extract<BroadcastChannelType, 'private' | 'presence'>,
  TUser,
  TPresenceMember extends BroadcastJsonObject,
  TWhispers extends BroadcastWhisperDefinitions,
>(
  pattern: TPattern,
  definition: ChannelDefinitionInput<TPattern, TType, TUser, TPresenceMember, TWhispers>,
): ChannelDefinition<TPattern, TType, TUser, TPresenceMember, TWhispers> {
  if (!isPlainObject(definition) || typeof definition.authorize !== 'function') {
    throw new Error('[Holo Broadcast] Channel definitions must define an authorize(...) function.')
  }

  if (definition.type !== 'private' && definition.type !== 'presence') {
    throw new Error('[Holo Broadcast] Channel definitions must use type "private" or "presence".')
  }

  return {
    pattern: normalizeChannelPattern(pattern, 'Channel pattern') as TPattern,
    type: definition.type,
    authorize: definition.authorize,
    whispers: normalizeWhisperDefinitions(definition.whispers) as Readonly<TWhispers>,
  }
}

export function defineChannel<
  TPattern extends string,
  TType extends Extract<BroadcastChannelType, 'private' | 'presence'>,
  TUser,
  TPresenceMember extends BroadcastJsonObject,
  TWhispers extends BroadcastWhisperDefinitions,
>(
  pattern: TPattern,
  definition: ChannelDefinitionInput<TPattern, TType, TUser, TPresenceMember, TWhispers>,
): ChannelDefinition<TPattern, TType, TUser, TPresenceMember, TWhispers> {
  const normalized = { ...normalizeChannelDefinition(pattern, definition) }
  Object.defineProperty(normalized, HOLO_CHANNEL_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })
  return Object.freeze(normalized)
}

export function channel<TPattern extends string>(
  pattern: TPattern,
  params?: BroadcastTargetParamInput,
): BroadcastChannelTarget<'public', TPattern> {
  return createChannelTarget('public', pattern, params)
}

export function privateChannel<TPattern extends string>(
  pattern: TPattern,
  params?: BroadcastTargetParamInput,
): BroadcastChannelTarget<'private', TPattern> {
  return createChannelTarget('private', pattern, params)
}

export function presenceChannel<TPattern extends string>(
  pattern: TPattern,
  params?: BroadcastTargetParamInput,
): BroadcastChannelTarget<'presence', TPattern> {
  return createChannelTarget('presence', pattern, params)
}

export type InferChannelPresenceMember<TChannel>
  = TChannel extends ChannelDefinition<string, 'presence', unknown, infer TPresenceMember, BroadcastWhisperDefinitions>
    ? TPresenceMember
    : never

export type InferChannelWhisperPayload<
  TChannel,
  TName extends string,
> = TChannel extends ChannelDefinition<string, Extract<BroadcastChannelType, 'private' | 'presence'>, unknown, BroadcastJsonObject, infer TWhispers>
  ? TName extends keyof TWhispers
    ? InferBroadcastWhisperPayload<TWhispers[TName]>
    : never
  : never

export type InferSchemaOutput<TSchema extends ValidationSchema> = InferSchemaData<TSchema['fields']>

export const broadcastInternals = {
  extractChannelPatternParamNames,
  formatChannelPattern,
  hasBroadcastDefinitionMarker(value: unknown): boolean {
    return isPlainObject(value) && HOLO_BROADCAST_DEFINITION_MARKER in value
  },
  hasChannelDefinitionMarker(value: unknown): boolean {
    return isPlainObject(value) && HOLO_CHANNEL_DEFINITION_MARKER in value
  },
  isBroadcastChannelTarget,
  isPlainObject,
  isReadonlyArray,
  normalizeBroadcastDefinition,
  normalizeChannelDefinition,
  normalizeChannelPattern,
  normalizeDelayValue,
  normalizeJsonValue,
  normalizeQueueOptions,
  normalizeWhisperDefinitions,
}
