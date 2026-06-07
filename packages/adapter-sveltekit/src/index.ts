import { AsyncLocalStorage } from 'node:async_hooks'
import { error as svelteKitError } from '@sveltejs/kit'
import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import {
  type SerializedValidationException,
  isValidationException,
  validationInternals,
} from '@holo-js/validation'
import type { HoloConfigMap } from '@holo-js/config'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

type SvelteKitRequestEvent = {
  readonly url?: URL
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
  readonly request: {
    readonly method?: string
    readonly headers: Headers
  }
}

type SvelteKitCookieOptions = {
  path: string
  domain?: string
  maxAge?: number
  expires?: Date
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  partitioned?: boolean
}

type ParsedResponseCookie = {
  readonly name: string
  readonly value: string
  readonly options: SvelteKitCookieOptions
}

type SvelteKitActionResult = {
  readonly type?: unknown
  readonly error?: unknown
}

type SvelteKitRuntimeGlobal = typeof globalThis & {
  __holoSvelteKitRequestEventStore?: AsyncLocalStorage<SvelteKitRequestEvent>
}

type SvelteKitModule = {
  readonly redirect: (status: SvelteKitRedirectStatus, location: string) => never
}

type SvelteKitRedirectStatus = 301 | 302 | 303 | 307 | 308
type SvelteKitErrorStatus = Parameters<typeof svelteKitError>[0]
type SvelteKitErrorBody = Parameters<typeof svelteKitError>[1]

// Shared AsyncLocalStorage contract with packages/auth/src/sveltekit/server.ts:
// keep this exact global key and compatible AsyncLocalStorage<SvelteKitRequestEvent>
// / AsyncLocalStorage<SvelteKitStoredRequestEvent> value types in sync.
const svelteKitAdapter = createHoloFrameworkAdapter<SvelteKitHoloOptions>({
  stateKey: '__holoSvelteKitAdapter__',
  displayName: 'SvelteKit',
})
const validationFlashCookie = 'HOLO-SVELTEKIT-VALIDATION'
let validationExceptionThrowerRegistered = false
const validationActionFailures = new WeakMap<object, SerializedValidationException>()
const validationActionFailureKeys = new Map<string, SerializedValidationException>()

function getSvelteKitRequestEventStore(): AsyncLocalStorage<SvelteKitRequestEvent> {
  const runtimeGlobal = globalThis as SvelteKitRuntimeGlobal
  runtimeGlobal.__holoSvelteKitRequestEventStore ??= new AsyncLocalStorage<SvelteKitRequestEvent>()

  return runtimeGlobal.__holoSvelteKitRequestEventStore
}

function toSvelteKitErrorStatus(status: number): SvelteKitErrorStatus {
  return status >= 400 && status <= 599 ? status as SvelteKitErrorStatus : 500
}

function isApiEvent(event: SvelteKitRequestEvent): boolean {
  return event.url?.pathname.startsWith('/api/') === true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSerializedValidationException(value: unknown): value is SerializedValidationException {
  return isPlainObject(value)
    && value.ok === false
    && typeof value.status === 'number'
    && value.valid === false
    && typeof value.message === 'string'
    && typeof value.bag === 'string'
    && isPlainObject(value.values)
    && isPlainObject(value.errors)
}

function serializeValidationException(error: unknown): SerializedValidationException | undefined {
  return isValidationException(error) ? error.toJSON() : undefined
}

function toSvelteKitValidationBody(payload: SerializedValidationException): SvelteKitErrorBody {
  return payload as SvelteKitErrorBody
}

function isSvelteKitActionJsonRequest(event: SvelteKitRequestEvent): boolean {
  return event.request.method?.toUpperCase() === 'POST'
    && event.request.headers.get('accept')?.toLowerCase().includes('application/json') === true
}

async function mapValidationActionResponse(
  event: SvelteKitRequestEvent,
  response: Response,
): Promise<Response> {
  if (isApiEvent(event)) {
    const apiPayload = takeValidationActionFailure(event)
    if (apiPayload) {
      return Response.json(apiPayload, { status: apiPayload.status })
    }

    return response
  }

  const flashedPayload = takeValidationActionFailure(event)
  if (flashedPayload) {
    return isSvelteKitActionJsonRequest(event)
      ? createValidationActionFailureResponse(flashedPayload, response, true)
      : createValidationActionRedirectResponse(event, flashedPayload)
  }

  if (!isSvelteKitActionJsonRequest(event)) {
    return response
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return response
  }

  let actionResult: SvelteKitActionResult
  try {
    actionResult = await response.clone().json() as SvelteKitActionResult
  } catch {
    return response
  }
  if (actionResult.type !== 'error' || !isSerializedValidationException(actionResult.error)) {
    return response
  }

  return createValidationActionFailureResponse(actionResult.error, response, false)
}

function encodeValidationFlashPayload(payload: SerializedValidationException): string {
  return encodeURIComponent(JSON.stringify({
    ...payload,
    values: filterFlashValues(payload.values),
  }))
}

function isSensitiveFlashKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  return normalized.startsWith('_')
    || normalized.includes('password')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('credential')
}

function filterFlashValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map(item => filterFlashValue(item))
      .filter(item => typeof item !== 'undefined')
  }

  if (!isPlainObject(value)) {
    return undefined
  }

  return filterFlashValues(value)
}

function filterFlashValues<TData extends Record<string, unknown>>(values: TData): Partial<TData> {
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isSensitiveFlashKey(key)) {
      continue
    }

    const next = filterFlashValue(value)
    if (typeof next !== 'undefined') {
      filtered[key] = next
    }
  }

  return filtered as Partial<TData>
}

function flashValidationPayload(event: SvelteKitRequestEvent, payload: SerializedValidationException): void {
  if (!event.url) {
    return
  }

  event.cookies.set(validationFlashCookie, encodeValidationFlashPayload(payload), {
    path: normalizeCookiePath(event),
    maxAge: 60,
    sameSite: 'lax',
  })
}

function normalizeCookiePath(event: SvelteKitRequestEvent): string {
  return (event.url?.pathname || '/').replace(/[;\r\n]/g, '') || '/'
}

function createValidationFlashCookie(event: SvelteKitRequestEvent, payload: SerializedValidationException): string {
  return [
    `${validationFlashCookie}=${encodeValidationFlashPayload(payload)}`,
    'Max-Age=60',
    `Path=${normalizeCookiePath(event)}`,
    'SameSite=Lax',
  ].join('; ')
}

function createValidationActionFailureResponse(
  payload: SerializedValidationException,
  response: Response,
  reloadWithFlash: boolean,
): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  if (reloadWithFlash) {
    headers.set('x-holo-validation-flash', '1')
  }

  return Response.json({
    type: 'failure',
    status: payload.status,
    data: JSON.stringify(payload),
  }, {
    status: 200,
    headers,
  })
}

function createValidationActionRedirectResponse(
  event: SvelteKitRequestEvent,
  payload: SerializedValidationException,
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: event.url?.pathname || '/',
      'cache-control': 'no-store',
      'set-cookie': createValidationFlashCookie(event, payload),
    },
  })
}

function getValidationActionFailureKey(event: SvelteKitRequestEvent): string | undefined {
  if (!event.url) {
    return undefined
  }

  return `${event.request.method?.toUpperCase() ?? 'GET'} ${event.url.href}`
}

function takeValidationActionFailure(event: SvelteKitRequestEvent): SerializedValidationException | undefined {
  const key = getValidationActionFailureKey(event)
  const eventPayload = validationActionFailures.get(event)
  if (eventPayload) {
    validationActionFailures.delete(event)
    validationActionFailures.delete(event.request)
    if (key) {
      validationActionFailureKeys.delete(key)
    }
    return eventPayload
  }

  const requestPayload = validationActionFailures.get(event.request)
  if (requestPayload) {
    validationActionFailures.delete(event)
    validationActionFailures.delete(event.request)
    if (key) {
      validationActionFailureKeys.delete(key)
    }
    return requestPayload
  }

  if (!key) {
    return undefined
  }

  const keyedPayload = validationActionFailureKeys.get(key)
  validationActionFailureKeys.delete(key)
  return keyedPayload
}

function rememberValidationActionFailure(event: SvelteKitRequestEvent, payload: SerializedValidationException): void {
  flashValidationPayload(event, payload)
  validationActionFailures.set(event, payload)
  validationActionFailures.set(event.request, payload)
  const key = getValidationActionFailureKey(event)
  if (key) {
    validationActionFailureKeys.set(key, payload)
  }
}

function registerValidationExceptionThrower(): void {
  if (validationExceptionThrowerRegistered) {
    return
  }

  validationExceptionThrowerRegistered = true
  validationInternals.setValidationExceptionThrower((exception) => {
    const event = getSvelteKitRequestEventStore().getStore()
    if (!event) {
      return
    }

    const payload = exception.toJSON()
    if (!isApiEvent(event)) {
      rememberValidationActionFailure(event, payload)
    }
    svelteKitError(toSvelteKitErrorStatus(payload.status), toSvelteKitValidationBody(payload))
  })
}

function safeDecodeCookieSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseResponseCookie(cookie: string): ParsedResponseCookie | null {
  const [nameValue = '', ...attributes] = cookie.split(';')
  const separator = nameValue.indexOf('=')
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: SvelteKitCookieOptions = { path: '/' }
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim()
    if (!attribute) {
      continue
    }

    const attributeSeparator = attribute.indexOf('=')
    const key = (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase()
    const value = attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim()

    switch (key) {
      case 'path':
        options.path = value || '/'
        break
      case 'domain':
        options.domain = value
        break
      case 'max-age': {
        const maxAge = Number(value)
        if (Number.isFinite(maxAge)) {
          options.maxAge = maxAge
        }
        break
      }
      case 'expires': {
        const expires = new Date(value)
        if (!Number.isNaN(expires.getTime())) {
          options.expires = expires
        }
        break
      }
      case 'secure':
        options.secure = true
        break
      case 'httponly':
        options.httpOnly = true
        break
      case 'samesite':
        if (value.toLowerCase() === 'lax' || value.toLowerCase() === 'strict' || value.toLowerCase() === 'none') {
          options.sameSite = value.toLowerCase() as SvelteKitCookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = value ? value.toLowerCase() === 'true' : true
        break
    }
  }

  return {
    name: safeDecodeCookieSegment(nameValue.slice(0, separator)),
    value: safeDecodeCookieSegment(nameValue.slice(separator + 1)),
    options,
  }
}

function resolveSvelteKitAuthRequestAccessors(): NonNullable<SvelteKitHoloOptions['authRequest']> {
  return {
    async getCookie(name: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      return event?.cookies.get(name) ?? undefined
    },
    async getHeader(name: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      return event?.request.headers.get(name) ?? undefined
    },
    appendResponseCookie(cookie: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      const parsed = parseResponseCookie(cookie)
      if (!event || !parsed) {
        return
      }

      event.cookies.set(parsed.name, parsed.value, parsed.options)
    },
    async redirectResponse(url: string, status: SvelteKitRedirectStatus = 307) {
      const { redirect } = await import('@sveltejs/kit') as SvelteKitModule
      redirect(status, url)
    },
  }
}

function resolveSvelteKitOptions(options: SvelteKitHoloOptions): SvelteKitHoloOptions {
  return {
    ...options,
    authRequest: options.authRequest ?? resolveSvelteKitAuthRequestAccessors(),
    authorizationError: options.authorizationError ?? {
      createError(decision) {
        const status = decision.status === 404 ? 404 : 403
        svelteKitError(status, decision.message ?? 'You are not authorized to perform this action.')
      },
    },
  }
}

export const svelteKitHoloCapabilities = svelteKitAdapter.capabilities

export function runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitRequestEvent,
  callback: () => TValue,
): TValue {
  registerValidationExceptionThrower()
  return getSvelteKitRequestEventStore().run(event, callback)
}

export async function createSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.createProject<TCustom>(resolveSvelteKitOptions(options))
}

export async function initializeSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.initializeProject<TCustom>(resolveSvelteKitOptions(options))
}

export function createSvelteKitHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
) {
  return svelteKitAdapter.createHelpers<TCustom>(resolveSvelteKitOptions(options))
}

export async function resetSvelteKitHoloProject(): Promise<void> {
  await svelteKitAdapter.resetProject()
}

export const adapterSvelteKitInternals = {
  ...svelteKitAdapter.internals,
  mapValidationActionResponse,
  rememberValidationActionFailure,
  isApiEvent,
  serializeValidationException,
  validationFlashCookie,
}
