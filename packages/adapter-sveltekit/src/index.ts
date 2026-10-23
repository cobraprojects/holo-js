import { getCurrentSvelteKitRequestEvent, runWithSvelteKitRequestEvent as runWithRequestEvent, type SvelteKitRequestEvent } from '@holo-js/adapter-shared/sveltekit/request-context'
import { serializeRateLimitError } from '@holo-js/adapter-shared/server-errors'
import { error as svelteKitError, type Handle, type HandleServerError } from '@sveltejs/kit'
import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import {
  type SerializedValidationException,
  serializeValidationException as serializeValidationFailure,
  validationInternals,
} from '@holo-js/validation'
import type { HoloConfigMap } from '@holo-js/config'
import { cookieEncryptionInternals, createCookieWriteUnavailableError, requestUrlInternals, sameOriginRedirectPath } from '@holo-js/kernel'
import { reportError } from '@holo-js/kernel/error-reporting'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

type SvelteKitCookieOptions = Parameters<SvelteKitRequestEvent['cookies']['set']>[2]

type ParsedResponseCookie = {
  readonly name: string
  readonly value: string
  readonly options: SvelteKitCookieOptions
}

type SvelteKitActionResult = {
  readonly type?: unknown
  readonly error?: unknown
}

type SvelteKitModule = {
  readonly redirect: (status: SvelteKitRedirectStatus, location: string) => never
}

type SvelteKitRedirectStatus = 301 | 302 | 303 | 307 | 308
type SvelteKitErrorStatus = Parameters<typeof svelteKitError>[0]
type SvelteKitErrorBody = Parameters<typeof svelteKitError>[1]

const svelteKitAdapter = createHoloFrameworkAdapter<SvelteKitHoloOptions>({
  stateKey: '__holoSvelteKitAdapter__',
  displayName: 'SvelteKit',
})

if (typeof process !== 'undefined') {
  process.once('sveltekit:shutdown', () => {
    void svelteKitAdapter.resetProject().catch((error: Error) => {
      console.error(error)
      process.exitCode = 1
    })
  })
}

const validationFlashCookie = 'HOLO-SVELTEKIT-VALIDATION'
let validationExceptionThrowerRegistered = false
type ValidationRequestState = {
  active: boolean
  payload?: SerializedValidationException
}

const validationRequests = new WeakMap<object, ValidationRequestState>()

function toSvelteKitErrorStatus(status: number): SvelteKitErrorStatus {
  return status >= 400 && status <= 599 ? status as SvelteKitErrorStatus : 500
}

function isApiEvent(event: SvelteKitRequestEvent): boolean {
  return event.url?.pathname.startsWith('/api/') === true
}

function isDebugEnabled(): boolean {
  return svelteKitAdapter.internals.getState().project?.config.app.debug === true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
  return serializeValidationFailure(error) ?? serializeRateLimitError(error)
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
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      headers.delete('content-encoding')
      headers.set('content-type', 'application/json')
      if (apiPayload.retryAfterSeconds !== undefined) headers.set('Retry-After', String(apiPayload.retryAfterSeconds))
      return Response.json(apiPayload, { status: apiPayload.status, headers })
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

function resolveValidationFlashAppKey(): string | undefined {
  const appKey = svelteKitAdapter.internals.getState().project?.config.app.key
  return appKey?.trim() ? appKey : undefined
}

function encodeValidationFlashPayload(payload: SerializedValidationException, pathname: string): string | undefined {
  const appKey = resolveValidationFlashAppKey()
  if (!appKey) {
    if (isDebugEnabled()) {
      console.warn('[@holo-js/adapter-sveltekit] Validation flash is skipped because the app key is empty. Set APP_KEY.')
    }
    return undefined
  }

  return cookieEncryptionInternals.encryptCookieValue(validationFlashCookie, JSON.stringify({
    ...payload,
    values: filterFlashValues(payload.values),
    path: pathname,
  }), appKey)
}

function isSensitiveFlashKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  return key.trimStart().startsWith('_')
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
  const value = event.url ? encodeValidationFlashPayload(payload, flashPathFor(event.url.pathname)) : undefined
  if (!value) {
    return
  }

  event.cookies.set(validationFlashCookie, value, {
    path: flashPathFor(event.url?.pathname),
    maxAge: 60,
    sameSite: 'lax',
    httpOnly: true,
  })
}

function flashPathFor(pathname: string | undefined): string {
  return sameOriginRedirectPath(pathname).replace(/[;\r\n]/g, '') || '/'
}

function normalizeCookiePath(event: SvelteKitRequestEvent): string {
  return (event.url?.pathname || '/').replace(/[;\r\n]/g, '') || '/'
}

function createValidationFlashCookie(pathname: string | undefined, payload: SerializedValidationException): string | undefined {
  const path = flashPathFor(pathname)
  const value = encodeValidationFlashPayload(payload, path)
  if (!value) {
    return undefined
  }

  return [
    `${validationFlashCookie}=${value}`,
    'Max-Age=60',
    `Path=${path}`,
    'SameSite=Lax',
    'HttpOnly',
  ].join('; ')
}

type ValidationFlashRecord = SerializedValidationException & { readonly path?: string }

function readValidationFlashCookie(value: string | undefined): ValidationFlashRecord | undefined {
  const appKey = resolveValidationFlashAppKey()
  const json = value && appKey
    ? cookieEncryptionInternals.decryptCookieValue(validationFlashCookie, value, appKey)
    : undefined
  if (!json) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(json)
    return isSerializedValidationException(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function readValidationFlash(url?: { readonly pathname: string }): ValidationFlashRecord | undefined {
  const event = getCurrentSvelteKitRequestEvent()
  const value = event?.cookies.get(validationFlashCookie)
  if (!event || !value) {
    return undefined
  }

  const payload = readValidationFlashCookie(value)
  event.cookies.delete(validationFlashCookie, { path: payload?.path ?? flashPathFor(event.url?.pathname) })
  const pathname = url?.pathname ?? event.url?.pathname
  return payload && payload.path === flashPathFor(pathname) ? payload : undefined
}

function createValidationActionFailureResponse(
  payload: SerializedValidationException,
  response: Response,
  reloadWithFlash: boolean,
): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
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
  const headers: Record<string, string> = {
    location: sameOriginRedirectPath(event.url?.pathname),
    'cache-control': 'no-store',
  }
  const flashCookie = createValidationFlashCookie(event.url?.pathname, payload)
  if (flashCookie) {
    headers['set-cookie'] = flashCookie
  }

  return new Response(null, { status: 303, headers })
}

function takeValidationActionFailure(event: SvelteKitRequestEvent): SerializedValidationException | undefined {
  const state = validationRequests.get(event.request)
  const payload = state?.payload
  if (state) state.payload = undefined
  return payload
}

function rememberValidationActionFailure(event: SvelteKitRequestEvent, payload: SerializedValidationException): void {
  const state = validationRequests.get(event.request)
  if (state && !state.active) return
  flashValidationPayload(event, payload)
  if (state) state.payload = payload
  else validationRequests.set(event.request, { active: true, payload })
}

function registerValidationExceptionThrower(): void {
  if (validationExceptionThrowerRegistered) {
    return
  }

  validationExceptionThrowerRegistered = true
  validationInternals.setValidationExceptionThrower((exception) => {
    const event = getCurrentSvelteKitRequestEvent()
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

  const options: SvelteKitCookieOptions = { path: '/', secure: false }
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
      const event = getCurrentSvelteKitRequestEvent()
      return event?.cookies.get(name) ?? undefined
    },
    async getHeader(name: string) {
      const event = getCurrentSvelteKitRequestEvent()
      return event?.request.headers.get(name) ?? undefined
    },
    canAppendResponseCookie() {
      return Boolean(getCurrentSvelteKitRequestEvent())
    },
    appendResponseCookie(cookie: string) {
      const event = getCurrentSvelteKitRequestEvent()
      if (!event) {
        throw createCookieWriteUnavailableError('Authentication cookies cannot be set outside an active SvelteKit request.')
      }
      const parsed = parseResponseCookie(cookie)
      if (!parsed) {
        throw new Error('[@holo-js/adapter-sveltekit] An authentication cookie could not be parsed.')
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

requestUrlInternals.provideConnectionAddress(() => getCurrentSvelteKitRequestEvent()?.getClientAddress?.())

export function runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitRequestEvent,
  callback: () => TValue,
): TValue {
  registerValidationExceptionThrower()
  return runWithRequestEvent(event, () => {
    const runtime = svelteKitAdapter.internals.getState().project?.runtime
    return runtime
      ? runtime.runWithAuthRequestAccessors(resolveSvelteKitAuthRequestAccessors(), callback)
      : callback()
  })
}

export function createSvelteKitHoloHooks(hooks: {
  readonly handle: Handle
  readonly handleError?: HandleServerError
}): {
  readonly handle: Handle
  readonly handleError: HandleServerError
} {
  return {
    handle: ({ event, resolve }) => runWithSvelteKitRequestEvent(event, async () => {
      const state: ValidationRequestState = { active: true }
      validationRequests.set(event.request, state)
      try {
        const response = await hooks.handle({ event, resolve })
        return await mapValidationActionResponse(event, response)
      } catch (error) {
        const payload = serializeValidationException(error)
        if (payload && isApiEvent(event)) {
          return Response.json(payload, { status: payload.status })
        }
        throw error
      } finally {
        state.active = false
        state.payload = undefined
      }
    }),
    handleError: async (input) => {
      const payload = serializeValidationException(input.error)
      if (payload) {
        const state = validationRequests.get(input.event.request)
        if (state?.active) rememberValidationActionFailure(input.event, payload)
        return payload
      }
      if (hooks.handleError) return hooks.handleError(input)
      if (input.status >= 500) reportError(input.error, { capability: 'sveltekit', operation: 'handleError' })
      if (input.error instanceof Error && isDebugEnabled()) return { message: input.error.message }
      return { message: input.message }
    },
  }
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
  createValidationActionFailureResponse,
  createValidationActionRedirectResponse,
  createValidationFlashCookie,
  encodeValidationFlashPayload,
  readValidationFlashCookie,
  filterFlashValue,
  filterFlashValues,
  flashValidationPayload,
  isPlainObject,
  isSensitiveFlashKey,
  isSerializedValidationException,
  isSvelteKitActionJsonRequest,
  mapValidationActionResponse,
  normalizeCookiePath,
  registerValidationExceptionThrower,
  resolveSvelteKitOptions,
  rememberValidationActionFailure,
  takeValidationActionFailure,
  toSvelteKitErrorStatus,
  toSvelteKitValidationBody,
  isApiEvent,
  serializeValidationException,
  validationFlashCookie,
}
