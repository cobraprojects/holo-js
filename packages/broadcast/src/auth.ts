import { createHmac } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@holo-js/validation'
import {
  type BroadcastAuthEndpointBody,
  type BroadcastAuthEndpointOptions,
  type BroadcastAuthEndpointPayload,
  type BroadcastJsonObject,
  type BroadcastChannelAuthRequest,
  type BroadcastChannelAuthResult,
  type BroadcastChannelAuthRuntimeBindings,
  type BroadcastWhisperValidationResult,
  type ChannelDefinition,
  type ChannelGuardResolverContext,
  type GeneratedChannelAuthRegistryEntry,
  isChannelDefinition,
} from './contracts'
import { isPlainObject, normalizeJsonValue } from './json'
import { getBroadcastRuntimeBindings } from './runtime'

type LoadedChannelDefinitions = Readonly<Record<string, ChannelDefinition>>
type MatchedChannelDefinition = {
  readonly definition: ChannelDefinition
  readonly params: Readonly<Record<string, string>>
}

type RuntimeState = {
  byBindings?: WeakMap<BroadcastChannelAuthRuntimeBindings, Promise<LoadedChannelDefinitions>>
}

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoBroadcastAuthRuntime__?: RuntimeState
  }

  runtime.__holoBroadcastAuthRuntime__ ??= {}
  return runtime.__holoBroadcastAuthRuntime__
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeOptionalString(value: string | undefined, label: string): string | undefined {
  /* v8 ignore next 3 -- current callers short-circuit undefined before invoking this helper */
  if (typeof value === 'undefined') {
    return undefined
  }

  return normalizeRequiredString(value, label)
}

function normalizeLookupChannel(channel: string, label: string): string {
  const normalized = normalizeRequiredString(channel, label)
  if (normalized.startsWith('private-')) {
    return normalized.slice('private-'.length)
  }

  if (normalized.startsWith('presence-')) {
    return normalized.slice('presence-'.length)
  }

  return normalized
}

function normalizePresenceMember(value: unknown): Readonly<BroadcastJsonObject> {
  if (!isPlainObject(value)) {
    throw new Error('[@holo-js/broadcast] Presence authorization must return a serializable member object when allowed.')
  }

  return normalizeJsonValue(value, 'Broadcast presence member', path => `[@holo-js/broadcast] ${path} must be JSON-serializable.`) as Readonly<BroadcastJsonObject>
}

function normalizeDefinitionMap(
  bindings: BroadcastChannelAuthRuntimeBindings,
): Readonly<Record<string, ChannelDefinition>> {
  const definitions = bindings.definitions
  if (!definitions) {
    return Object.freeze({})
  }

  const normalized = new Map<string, ChannelDefinition>()
  const addDefinition = (definition: ChannelDefinition, source: string): void => {
    if (normalized.has(definition.pattern)) {
      throw new Error(`[@holo-js/broadcast] duplicate broadcast channel pattern "${definition.pattern}" was configured more than once (${source}).`)
    }

    normalized.set(definition.pattern, definition)
  }

  if (Array.isArray(definitions)) {
    definitions.forEach((definition) => {
      if (!isChannelDefinition(definition)) {
        throw new Error('[@holo-js/broadcast] Broadcast channel auth definitions must contain only defineChannel(...) values.')
      }
      addDefinition(definition, 'array')
    })

    return Object.freeze(Object.fromEntries(normalized))
  }

  for (const [pattern, definition] of Object.entries(definitions)) {
    if (!isChannelDefinition(definition)) {
      throw new Error(`[@holo-js/broadcast] Broadcast channel auth definition "${pattern}" is not a defineChannel(...) value.`)
    }
    addDefinition(definition, `entry "${pattern}"`)
  }

  return Object.freeze(Object.fromEntries(normalized))
}

function normalizeRegistryEntry(
  entry: GeneratedChannelAuthRegistryEntry,
): GeneratedChannelAuthRegistryEntry {
  return Object.freeze({
    sourcePath: normalizeRequiredString(entry.sourcePath, 'Broadcast channel source path'),
    pattern: normalizeRequiredString(entry.pattern, 'Broadcast channel pattern'),
    type: entry.type,
    params: Object.freeze([...entry.params]),
    whispers: Object.freeze([...entry.whispers]),
    ...(typeof entry.guard === 'string'
      ? { guard: normalizeRequiredString(entry.guard, 'Broadcast channel guard') }
      : {}),
    ...(typeof entry.exportName === 'string'
      ? { exportName: normalizeRequiredString(entry.exportName, 'Broadcast channel exportName') }
      : {}),
  })
}

async function importChannelDefinition(
  entry: GeneratedChannelAuthRegistryEntry,
  bindings: BroadcastChannelAuthRuntimeBindings,
): Promise<ChannelDefinition> {
  const registry = bindings.registry
  if (!registry) {
    throw new Error('[@holo-js/broadcast] Broadcast channel registry bindings are missing.')
  }

  const importPath = resolve(registry.projectRoot, entry.sourcePath)
  const importer = bindings.importModule
    ?? (async (absolutePath: string) => await import(pathToFileURL(absolutePath).href))
  const moduleValue = await importer(importPath)
  if (!isPlainObject(moduleValue)) {
    throw new Error(`[@holo-js/broadcast] Broadcast channel module "${entry.sourcePath}" must export an object module namespace.`)
  }

  const exportName = entry.exportName ?? 'default'
  const definition = moduleValue[exportName]
  if (!isChannelDefinition(definition)) {
    throw new Error(`[@holo-js/broadcast] Broadcast channel "${entry.sourcePath}" export "${exportName}" is not a channel definition.`)
  }

  return definition
}

async function loadRegistryDefinitions(
  bindings: BroadcastChannelAuthRuntimeBindings,
): Promise<Readonly<Record<string, ChannelDefinition>>> {
  const registry = bindings.registry
  if (!registry) {
    return Object.freeze({})
  }

  const entries = registry.channels.map(normalizeRegistryEntry)
  const definitions = await Promise.all(entries.map(async (entry) => {
    const definition = await importChannelDefinition(entry, bindings)
    return [definition.pattern, definition] as const
  }))
  const seenPatterns = new Set<string>()
  for (const [pattern] of definitions) {
    if (seenPatterns.has(pattern)) {
      throw new Error(`[@holo-js/broadcast] duplicate broadcast channel pattern "${pattern}" was configured more than once (registry).`)
    }
    seenPatterns.add(pattern)
  }

  return Object.freeze(Object.fromEntries(definitions))
}

async function loadChannelDefinitions(
  bindings: BroadcastChannelAuthRuntimeBindings,
): Promise<LoadedChannelDefinitions> {
  const cached = getRuntimeState().byBindings?.get(bindings)
  if (cached) {
    return await cached
  }

  const pending = (async () => {
    const inlineDefinitions = normalizeDefinitionMap(bindings)
    const registryDefinitions = await loadRegistryDefinitions(bindings)
    const duplicatePattern = Object.keys(inlineDefinitions).find(pattern => Object.hasOwn(registryDefinitions, pattern))
    if (duplicatePattern) {
      throw new Error(`[@holo-js/broadcast] duplicate broadcast channel pattern "${duplicatePattern}" was configured in both inline definitions and registry definitions.`)
    }

    const merged = Object.freeze({
      ...inlineDefinitions,
      ...registryDefinitions,
    })

    return merged
  })()

  getRuntimeState().byBindings ??= new WeakMap()
  getRuntimeState().byBindings!.set(bindings, pending)
  try {
    return await pending
  } catch (error) {
    const cache = getRuntimeState().byBindings!
    if (cache.get(bindings) === pending) {
      cache.delete(bindings)
    }

    throw error
  }
}

function matchPattern(pattern: string, channel: string): Readonly<Record<string, string>> | null {
  const patternSegments = pattern.split('.')
  const channelSegments = channel.split('.')
  if (patternSegments.length !== channelSegments.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index]!
    const channelSegment = channelSegments[index]!
    const wildcardMatch = patternSegment.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
    if (wildcardMatch) {
      params[wildcardMatch[1]!] = channelSegment
      continue
    }

    if (patternSegment !== channelSegment) {
      return null
    }
  }

  return Object.freeze(params)
}

function resolveChannelMatch(
  channel: string,
  definitions: LoadedChannelDefinitions,
): MatchedChannelDefinition | null {
  for (const definition of Object.values(definitions)) {
    const params = matchPattern(definition.pattern, channel)
    if (!params) {
      continue
    }

    if (definition.pattern === channel || Object.keys(params).length === 0) {
      return Object.freeze({
        definition,
        params,
      })
    }
  }

  for (const definition of Object.values(definitions)) {
    const params = matchPattern(definition.pattern, channel)
    if (!params) {
      continue
    }

    return Object.freeze({
      definition,
      params,
    })
  }

  return null
}

async function resolveAuthDefinitions(
  override?: BroadcastChannelAuthRuntimeBindings,
): Promise<LoadedChannelDefinitions> {
  const bindings = override ?? getBroadcastRuntimeBindings().channelAuth
  if (!bindings) {
    return Object.freeze({})
  }

  return await loadChannelDefinitions(bindings)
}

async function resolveBroadcastChannelMatch(
  channel: string,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
): Promise<MatchedChannelDefinition | null> {
  const definitions = await resolveAuthDefinitions(channelAuth)
  return resolveChannelMatch(normalizeLookupChannel(channel, 'Broadcast auth channel'), definitions)
}

async function resolveChannelGuard(
  channel: string,
  socketId: string | undefined,
  match: MatchedChannelDefinition,
): Promise<string | undefined> {
  if (typeof match.definition.guard === 'undefined') {
    return undefined
  }

  if (typeof match.definition.guard === 'function') {
    const context: ChannelGuardResolverContext = {
      channel,
      ...(typeof socketId === 'undefined' ? {} : { socketId }),
      params: match.params as ChannelGuardResolverContext['params'],
    }
    return await match.definition.guard(context)
  }

  return match.definition.guard
}

async function authorizeMatchedBroadcastChannel(
  channel: string,
  user: unknown,
  match: MatchedChannelDefinition,
): Promise<BroadcastChannelAuthResult> {
  const decision = await match.definition.authorize(user, match.params as never)
  if (match.definition.type === 'private') {
    if (decision !== true) {
      return Object.freeze({
        ok: false,
        channel,
        code: 'unauthorized',
      })
    }

    return Object.freeze({
      ok: true,
      channel,
      type: 'private',
      pattern: match.definition.pattern,
      params: match.params,
      whispers: Object.freeze(Object.keys(match.definition.whispers)),
    })
  }

  if (decision === false) {
    return Object.freeze({
      ok: false,
      channel,
      code: 'unauthorized',
    })
  }

  return Object.freeze({
    ok: true,
    channel,
    type: 'presence',
    pattern: match.definition.pattern,
    params: match.params,
    member: normalizePresenceMember(decision),
    whispers: Object.freeze(Object.keys(match.definition.whispers)),
  })
}

export async function authorizeBroadcastChannel(
  input: BroadcastChannelAuthRequest,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
): Promise<BroadcastChannelAuthResult> {
  const channel = normalizeRequiredString(input.channel, 'Broadcast auth channel')
  const match = await resolveBroadcastChannelMatch(channel, channelAuth)
  if (!match) {
    return Object.freeze({
      ok: false,
      channel,
      code: 'not-found',
    })
  }

  return await authorizeMatchedBroadcastChannel(channel, input.user, match)
}

export async function resolveBroadcastChannelGuard(
  input: Pick<BroadcastChannelAuthRequest, 'channel' | 'socketId'>,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
): Promise<string | undefined> {
  const channel = normalizeRequiredString(input.channel, 'Broadcast auth channel')
  const match = await resolveBroadcastChannelMatch(channel, channelAuth)
  if (!match) {
    return undefined
  }

  return await resolveChannelGuard(channel, input.socketId, match)
}

export async function resolveBroadcastWhisperSchema(
  channel: string,
  event: string,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
): Promise<{ readonly channel: string, readonly event: string, readonly schema: unknown } | null> {
  const normalizedChannel = normalizeRequiredString(channel, 'Broadcast whisper channel')
  const normalizedEvent = normalizeRequiredString(event, 'Broadcast whisper event')
  const definitions = await resolveAuthDefinitions(channelAuth)
  const match = resolveChannelMatch(
    normalizeLookupChannel(normalizedChannel, 'Broadcast whisper channel'),
    definitions,
  )
  if (!match) {
    return null
  }

  const schema = match.definition.whispers[normalizedEvent]
  if (!schema) {
    return null
  }

  return Object.freeze({
    channel: normalizedChannel,
    event: normalizedEvent,
    schema,
  })
}

export async function validateBroadcastWhisperPayload<TPayload extends BroadcastJsonObject = BroadcastJsonObject>(
  channel: string,
  event: string,
  payload: BroadcastJsonObject,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
): Promise<BroadcastWhisperValidationResult<TPayload>> {
  const resolved = await resolveBroadcastWhisperSchema(channel, event, channelAuth)
  if (!resolved) {
    throw new Error(`[@holo-js/broadcast] Whisper "${event}" is not allowed for channel "${channel}".`)
  }

  const validated = await parse(payload, resolved.schema as Parameters<typeof parse>[1]) as TPayload
  return Object.freeze({
    channel: resolved.channel,
    event: resolved.event,
    payload: Object.freeze({ ...validated }) as Readonly<TPayload>,
  })
}

export async function parseBroadcastAuthEndpointPayload(request: Request): Promise<BroadcastAuthEndpointPayload> {
  if (request.method.toUpperCase() !== 'POST') {
    throw new Error('method-not-allowed')
  }

  const contentType = request.headers.get('content-type') ?? ''
  let rawChannel: string | undefined
  let rawSocketId: string | undefined

  if (contentType.includes('application/json')) {
    const body = await request.json() as Record<string, unknown>
    rawChannel = typeof body.channel_name === 'string' ? body.channel_name : undefined
    rawChannel ??= typeof body.channel === 'string' ? body.channel : undefined
    rawSocketId = typeof body.socket_id === 'string' ? body.socket_id : undefined
    rawSocketId ??= typeof body.socketId === 'string' ? body.socketId : undefined
  } else {
    const formData = await request.formData()
    const channel = formData.get('channel_name') ?? formData.get('channel')
    const socketId = formData.get('socket_id') ?? formData.get('socketId')
    rawChannel = typeof channel === 'string' ? channel : undefined
    rawSocketId = typeof socketId === 'string' ? socketId : undefined
  }

  return Object.freeze({
    channel: normalizeRequiredString(rawChannel ?? '', 'Broadcast auth channel'),
    ...(typeof rawSocketId === 'undefined'
      ? {}
      : { socketId: normalizeOptionalString(rawSocketId, 'Broadcast auth socket id') }),
  })
}

function jsonResponse(body: BroadcastAuthEndpointBody, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function signBroadcastAuth(appSecret: string, socketId: string, channel: string, channelData: string): string {
  const value = channelData ? `${socketId}:${channel}:${channelData}` : `${socketId}:${channel}`
  return createHmac('sha256', appSecret).update(value).digest('hex')
}

export async function renderBroadcastAuthResponse(
  request: Request,
  options: BroadcastAuthEndpointOptions = {},
): Promise<Response> {
  let payload: BroadcastAuthEndpointPayload
  try {
    payload = await parseBroadcastAuthEndpointPayload(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid broadcast auth request.'
    if (message === 'method-not-allowed') {
      return jsonResponse({
        ok: false,
        error: 'method-not-allowed',
        message: 'Broadcast auth endpoint only supports POST.',
      }, 405)
    }

    return jsonResponse({
      ok: false,
      error: 'invalid-request',
      message,
    }, 400)
  }

  const channel = normalizeRequiredString(payload.channel, 'Broadcast auth channel')
  const match = await resolveBroadcastChannelMatch(channel, options.channelAuth)
  if (!match) {
    return jsonResponse({
      ok: false,
      error: 'not-found',
      message: `No channel authorization rule matches "${channel}".`,
    }, 404)
  }

  const guard = await resolveChannelGuard(channel, payload.socketId, match)
  const user = typeof options.resolveUser === 'function'
    ? await options.resolveUser(request, {
      channel,
      ...(typeof payload.socketId === 'undefined' ? {} : { socketId: payload.socketId }),
      ...(typeof guard === 'undefined' ? {} : { guard }),
    })
    : options.user
  if (typeof user === 'undefined' || user === null) {
    return jsonResponse({
      ok: false,
      error: 'unauthenticated',
      message: 'Broadcast channel authorization requires an authenticated user.',
    }, 401)
  }

  const result = await authorizeMatchedBroadcastChannel(channel, user, match)

  if (!result.ok) {
    return jsonResponse({
      ok: false,
      error: 'unauthorized',
      message: `Channel authorization denied for "${result.channel}".`,
    }, 403)
  }

  const channelData = JSON.stringify({
    whispers: result.whispers,
    ...(result.type === 'presence' ? { member: result.member } : {}),
  })
  const signed = options.appKey && options.appSecret && payload.socketId
    ? {
        auth: `${options.appKey}:${signBroadcastAuth(options.appSecret, payload.socketId, channel, channelData)}`,
        channel_data: channelData,
      }
    : {}

  return jsonResponse({
    ok: true,
    channel: result.channel,
    type: result.type,
    params: result.params,
    whispers: result.whispers,
    ...signed,
    ...(result.type === 'presence' ? { member: result.member } : {}),
  }, 200)
}

export const broadcastAuthInternals = {
  importChannelDefinition,
  loadChannelDefinitions,
  matchPattern,
  parseBroadcastAuthEndpointPayload,
  resolveAuthDefinitions,
  resolveChannelMatch,
  resolveChannelMatchFromMap(
    channel: string,
    definitions: Readonly<Record<string, ChannelDefinition>>,
  ): MatchedChannelDefinition | null {
    return resolveChannelMatch(channel, definitions as LoadedChannelDefinitions)
  },
  reset() {
    getRuntimeState().byBindings = undefined
  },
}
