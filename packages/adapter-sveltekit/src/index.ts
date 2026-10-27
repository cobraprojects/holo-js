import { getCurrentSvelteKitRequestEvent, runWithSvelteKitRequestEvent as runWithRequestEvent, type SvelteKitRequestEvent } from '@holo-js/adapter-shared/sveltekit/request-context'
import { serializeRateLimitError } from '@holo-js/adapter-shared/server-errors'
import { error as svelteKitError } from '@sveltejs/kit'
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks'
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
import { cookieEncryptionInternals, responseCookieInternals, createCookieWriteUnavailableError, requestUrlInternals, sameOriginRedirectPath } from '@holo-js/kernel'
import { reportError } from '@holo-js/kernel/error-reporting'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

type SvelteKitActionResult = {
  readonly type?: unknown
  readonly error?: unknown
}

type SvelteKitModule = {
  readonly redirect: (status: SvelteKitRedirectStatus, location: string, options?: { readonly external: true }) => never
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

type CaughtErrorInput = Parameters<HandleServerError>[0]

function caughtErrorStatus(input: CaughtErrorInput): number {
  return input.kind === 'unknown' ? 500 : input.error.status
}

function caughtErrorMessage(input: CaughtErrorInput): string {
  return input.kind === 'unknown' ? 'Internal Error' : input.error.message
}

function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

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

  const { pagePath, cookiePath } = validationFlashPaths(pathname)
  return cookieEncryptionInternals.encryptCookieValue(validationFlashCookie, JSON.stringify({
    ...payload,
    values: filterFlashValues(payload.values),
    path: pagePath,
    cookiePath,
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
  const value = event.url ? fitValidationFlash(payload, event.url.pathname) : undefined
  if (!value) {
    return
  }

  event.cookies.set(validationFlashCookie, value, {
    path: validationFlashPaths(event.url?.pathname).cookiePath,
    maxAge: 60,
    sameSite: 'lax',
    httpOnly: true,
  })
}

type ValidationFlashPaths = {
  // The exact same-origin page path. The flash only applies on this path.
  readonly pagePath: string
  // The cookie Path attribute. It may be broader than pagePath so the browser sends the cookie back.
  readonly cookiePath: string
}

function validationFlashPaths(pathname: string | undefined): ValidationFlashPaths {
  const pagePath = sameOriginRedirectPath(pathname)
  return { pagePath, cookiePath: cookiePathFor(pagePath) }
}

// A cookie Path cannot contain ';' or control characters (RFC 6265 §5.4). When the page path has one,
// use the nearest ancestor directory that is valid. It still path-matches the page (RFC 6265 §5.1.4).
function cookiePathFor(pagePath: string): string {
  if (isValidCookiePath(pagePath)) {
    return pagePath
  }

  let end = pagePath.lastIndexOf('/')
  while (end > 0 && !isValidCookiePath(pagePath.slice(0, end + 1))) {
    end = pagePath.lastIndexOf('/', end - 1)
  }

  return end > 0 ? pagePath.slice(0, end + 1) : '/'
}

function isValidCookiePath(path: string): boolean {
  return !path.includes(';') && ![...path].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

// Browsers drop a Set-Cookie over about 4096 bytes, so the whole header has to stay under this budget.
const VALIDATION_FLASH_COOKIE_BUDGET = 4000

function validationFlashCookieHeader(value: string, cookiePath: string): string {
  return [
    `${validationFlashCookie}=${value}`,
    'Max-Age=60',
    `Path=${cookiePath}`,
    'SameSite=Lax',
    'HttpOnly',
  ].join('; ')
}

// Old input is sized from at most this many fields, so a form with thousands of fields costs bounded work.
const VALIDATION_FLASH_FIELD_LIMIT = 200
// AES-GCM adds a 12-byte IV and a 16-byte tag. base64url then encodes the bytes without padding.
const FLASH_CIPHER_OVERHEAD_BYTES = 12 + 16

function encryptedFlashLength(plaintextBytes: number): number {
  return Math.ceil(((FLASH_CIPHER_OVERHEAD_BYTES + plaintextBytes) * 4) / 3)
}

// Degrades in order so the errors survive: drop the largest input values until the flash fits, then keep
// only the first message for each field, then fall back to a generic failure with no input. Sizes come from
// the plaintext arithmetically, so nothing is encrypted until the one value that is written. If the estimate
// is ever off, the generic flash is written directly.
function fitValidationFlash(payload: SerializedValidationException, pathname: string | undefined): string | undefined {
  const { pagePath, cookiePath } = validationFlashPaths(pathname)
  const headerOverhead = validationFlashCookieHeader('', cookiePath).length
  // The encoder writes "values":{} and "errors":{}; those four bytes are replaced by the real sizes below.
  const plaintextFrame = Buffer.byteLength(JSON.stringify({ ...payload, values: {}, errors: {}, path: pagePath, cookiePath })) - 4
  const fitsBudget = (plaintextBytes: number): boolean =>
    headerOverhead + encryptedFlashLength(plaintextBytes) <= VALIDATION_FLASH_COOKIE_BUDGET

  const fields = Object.entries(filterFlashValues(payload.values))
  const considered = new Map(fields.slice(0, VALIDATION_FLASH_FIELD_LIMIT))
  const capped = fields.slice(VALIDATION_FLASH_FIELD_LIMIT).map(([key]) => `values.${key}`)
  const sized = [...considered].map(([key, value]) => ({
    key,
    bytes: Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)}`),
  })).sort((a, b) => b.bytes - a.bytes)

  // The smallest number of largest fields to drop so the plaintext fits, or undefined when even none fit.
  const largestFirstDropCount = (errors: SerializedValidationException['errors']): number | undefined => {
    const errorsBytes = Buffer.byteLength(JSON.stringify(errors))
    let remainingBytes = sized.reduce((sum, field) => sum + field.bytes, 0)
    let remainingCount = sized.length
    for (let dropped = 0; ; dropped += 1) {
      if (fitsBudget(plaintextFrame + 2 + remainingBytes + Math.max(0, remainingCount - 1) + errorsBytes)) {
        return dropped
      }

      const next = sized[dropped]
      if (!next) {
        return undefined
      }

      remainingBytes -= next.bytes
      remainingCount -= 1
    }
  }
  const keptValues = (dropped: number) => Object.fromEntries(
    sized.slice(dropped).map(({ key }) => [key, considered.get(key)]),
  )
  const droppedNames = (dropped: number) => sized.slice(0, dropped).map(({ key }) => `values.${key}`)

  const encodeOnce = (candidate: SerializedValidationException): string | undefined => {
    const value = encodeValidationFlashPayload(candidate, pagePath)
    return value && validationFlashCookieHeader(value, cookiePath).length <= VALIDATION_FLASH_COOKIE_BUDGET
      ? value
      : undefined
  }
  const generic = (): string | undefined => {
    warnDroppedFlashFields([
      ...fields.map(([key]) => `values.${key}`),
      ...Object.keys(payload.errors).map(field => `errors.${field}`),
    ])
    return encodeOnce({ ...payload, message: 'Validation failed.', values: {}, errors: { _root: ['Validation failed.'] } })
  }

  const dropped = largestFirstDropCount(payload.errors)
  if (dropped !== undefined) {
    warnDroppedFlashFields([...capped, ...droppedNames(dropped)])
    return encodeOnce({ ...payload, values: keptValues(dropped) }) ?? generic()
  }

  const firstErrors = Object.fromEntries(
    Object.entries(payload.errors).map(([field, messages]) => [field, messages.slice(0, 1)]),
  )
  const droppedWithFirstErrors = largestFirstDropCount(firstErrors)
  if (droppedWithFirstErrors !== undefined) {
    const trimmed = Object.entries(payload.errors)
      .filter(([, messages]) => messages.length > 1)
      .map(([field]) => `errors.${field}`)
    warnDroppedFlashFields([...capped, ...droppedNames(droppedWithFirstErrors), ...trimmed])
    return encodeOnce({ ...payload, values: keptValues(droppedWithFirstErrors), errors: firstErrors }) ?? generic()
  }

  return generic()
}

function warnDroppedFlashFields(fields: readonly string[]): void {
  if (fields.length > 0 && isDebugEnabled()) {
    console.warn(`[@holo-js/adapter-sveltekit] Validation flash dropped ${fields.join(', ')} to fit the ${VALIDATION_FLASH_COOKIE_BUDGET}-byte cookie budget.`)
  }
}

function createValidationFlashCookie(pathname: string | undefined, payload: SerializedValidationException): string | undefined {
  const value = fitValidationFlash(payload, pathname)
  if (!value) {
    return undefined
  }

  return validationFlashCookieHeader(value, validationFlashPaths(pathname).cookiePath)
}

type ValidationFlashRecord = SerializedValidationException & { readonly path?: string, readonly cookiePath?: string }

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
  event.cookies.delete(validationFlashCookie, {
    path: payload?.cookiePath ?? validationFlashPaths(event.url?.pathname).cookiePath,
  })
  const pagePath = validationFlashPaths(url?.pathname ?? event.url?.pathname).pagePath
  return payload && payload.path === pagePath ? payload : undefined
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
      const parsed = responseCookieInternals.parseResponseCookie(cookie)
      if (!parsed) {
        throw new Error('[@holo-js/adapter-sveltekit] An authentication cookie could not be parsed.')
      }

      event.cookies.set(parsed.name, parsed.value, parsed.options)
    },
    async redirectResponse(url: string, status: SvelteKitRedirectStatus = 307) {
      const { redirect } = await import('@sveltejs/kit') as SvelteKitModule
      redirect(status, url, isAbsoluteHttpUrl(url) ? { external: true } : undefined)
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
    handleError: (input) => {
      const payload = serializeValidationException(input.error)
      if (payload) {
        const state = validationRequests.get(input.event.request)
        if (state?.active) rememberValidationActionFailure(input.event, payload)
        return payload
      }
      if (hooks.handleError) return hooks.handleError(input)
      if (caughtErrorStatus(input) >= 500) reportError(input.error, { capability: 'sveltekit', operation: 'handleError' })
      if (input.error instanceof Error && isDebugEnabled()) return { message: input.error.message }
      return { message: caughtErrorMessage(input) }
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
  resolveSvelteKitAuthRequestAccessors,
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
