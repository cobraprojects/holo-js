import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { initializeHolo, type CreateHoloOptions } from '@holo-js/core/runtime'
import { createCookieWriteUnavailableError } from '@holo-js/kernel'
import { captureErrorReporter } from '@holo-js/kernel/error-reporting'
import type { DotPath, HoloConfigMap, HoloConfigValues, ValueAtPath } from '@holo-js/config'
import { validationInternals, type SerializedValidationException } from '@holo-js/validation'
import { serializeRateLimitError } from '@holo-js/adapter-shared/server-errors'
import { getCurrentNextRequest, setNextAuthRequestRunner, type NextRequestLike } from './request-context'
import { currentWorkUnitStore, loadNextAsyncStorage, requireNextFromProject, type NextActionStore, type NextWorkUnitStore } from './next-async-storage'
import { rememberRenderedValidationFlash } from './rendered-validation-flash'
import { installNextShutdown } from './shutdown'
import { VALIDATION_FLASH_COOKIE, serializeValidationFlash, validationFlashPage } from './validation-flash'
export { runWithNextRequest, type NextRequestLike } from './request-context'

export type NextHoloRuntimeOptions = CreateHoloOptions & {
  readonly projectRoot: string
}

type ResponseCookieOptions = {
  path?: string
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
  readonly options: ResponseCookieOptions
}

type MutableNextCookieStore = {
  set(name: string, value: string, options?: ResponseCookieOptions): void
}

type NextNavigationModule = {
  readonly redirect: (url: string) => never
}

type NextHttpAccessFallbackError = Error & {
  digest: `NEXT_HTTP_ERROR_FALLBACK;${403 | 404}`
}

type NextHeadersModule = {
  readonly cookies: () => Promise<{
    get(name: string): { value?: string } | undefined
    set?(name: string, value: string, options?: ResponseCookieOptions): void
  }>
  readonly headers: () => Promise<Headers>
}

function createNextHttpAccessFallbackError(status: 403 | 404, message: string): never {
  const error = new Error(message) as NextHttpAccessFallbackError
  error.digest = `NEXT_HTTP_ERROR_FALLBACK;${status}`
  throw error
}

type NextRequestWithCookies = Request & {
  readonly cookies?: {
    get(name: string): { readonly value?: string } | undefined
  }
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

  const options: ResponseCookieOptions = {}
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
        options.path = value
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
          options.sameSite = value.toLowerCase() as ResponseCookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = true
        break
    }
  }

  return {
    name: safeDecodeCookieSegment(nameValue.slice(0, separator)),
    value: safeDecodeCookieSegment(nameValue.slice(separator + 1)),
    options,
  }
}

function parseRequestCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const segment of header?.split(';') ?? []) {
    const separator = segment.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const name = safeDecodeCookieSegment(segment.slice(0, separator).trim())
    const value = safeDecodeCookieSegment(segment.slice(separator + 1).trim())
    if (name) {
      cookies.set(name, value)
    }
  }

  return cookies
}

function isMissingNextRequestScope(error: unknown): boolean {
  return error instanceof Error && error.message.includes('outside a request scope')
}

function nextCookiesMutableInCurrentPhase(requireNext: (id: string) => unknown): boolean {
  const workUnitAsyncStorage = loadNextAsyncStorage<NextWorkUnitStore>(requireNext, 'work-unit')
  return !workUnitAsyncStorage || workUnitAsyncStorage.getStore()?.phase === 'action'
}

function isReadonlyNextCookieStore(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Cookies can only be modified in a Server Action or Route Handler')
}

export function createNextRequestContext(request: Request): NextRequestLike {
  const nextRequest = request as NextRequestWithCookies
  const parsedCookies = nextRequest.cookies ? undefined : parseRequestCookies(request.headers.get('cookie'))

  return {
    url: request.url,
    headers: request.headers,
    cookies: {
      get(name) {
        const nextCookie = nextRequest.cookies?.get(name)
        if (nextCookie && typeof nextCookie.value === 'string') {
          return { value: nextCookie.value }
        }

        const value = parsedCookies?.get(name)
        return typeof value === 'string' ? { value } : undefined
      },
    },
  }
}

function resolveNextAuthRequestAccessors(projectRoot = process.cwd()): NonNullable<CreateHoloOptions['authRequest']> {
  const requireNext = createRequire(resolve(projectRoot, 'package.json'))
  return {
    async getCookie(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.cookies.get(name)?.value
      }

      try {
        const { cookies } = requireNext('next/headers.js') as NextHeadersModule
        const store = await cookies()
        return store.get(name)?.value
      } catch (error) {
        if (isMissingNextRequestScope(error)) return undefined
        throw error
      }
    },
    async getHeader(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.headers.get(name) ?? undefined
      }

      try {
        const { headers } = requireNext('next/headers.js') as NextHeadersModule
        const requestHeaders = await headers()
        return requestHeaders.get(name) ?? undefined
      } catch (error) {
        if (isMissingNextRequestScope(error)) return undefined
        throw error
      }
    },
    async canAppendResponseCookie() {
      try {
        const { cookies } = requireNext('next/headers.js') as NextHeadersModule
        await cookies()
      } catch (error) {
        if (isMissingNextRequestScope(error)) return false
        throw error
      }
      return nextCookiesMutableInCurrentPhase(requireNext)
    },
    async appendResponseCookie(cookie: string) {
      const parsed = parseResponseCookie(cookie)
      if (!parsed) {
        throw new Error('[@holo-js/adapter-next] An authentication cookie could not be parsed.')
      }

      try {
        const { cookies } = requireNext('next/headers.js') as NextHeadersModule
        const store = await cookies() as MutableNextCookieStore
        store.set(parsed.name, parsed.value, parsed.options)
      } catch (error) {
        if (isMissingNextRequestScope(error) || isReadonlyNextCookieStore(error)) {
          throw createCookieWriteUnavailableError(
            'Cookies can only be set in a Server Action or Route Handler, not while rendering a Server Component.',
            error,
          )
        }
        throw error
      }
    },
    async redirectResponse(url: string) {
      const { redirect } = requireNext('next/navigation.js') as NextNavigationModule
      redirect(url)
    },
  }
}

export function createNextHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloRuntimeOptions,
) {
  const authRequest = options.authRequest ?? resolveNextAuthRequestAccessors(options.projectRoot)
  const resolveRuntime = async () => {
    const pendingRuntime = initializeHolo<TCustom>(options.projectRoot, {
      ...options,
      authRequest,
      authorizationError: options.authorizationError ?? {
        createError(decision) {
          if (decision.status === 404) {
            return createNextHttpAccessFallbackError(404, decision.message ?? 'Resource not found.')
          }

          return createNextHttpAccessFallbackError(403, decision.message ?? 'Forbidden')
        },
      },
    })
    let report: ReturnType<typeof captureErrorReporter> | undefined
    installNextShutdown({
      close: async () => {
        const runtime = await pendingRuntime.catch(() => undefined)
        if (!runtime) return
        report = captureErrorReporter()
        await runtime.shutdown()
      },
      report: (error, context) => (report ?? captureErrorReporter())(error, context),
    })
    const runtime = await pendingRuntime
    setNextAuthRequestRunner(callback => runtime.runWithAuthRequestAccessors(authRequest, callback))
    return runtime
  }

  const useConfig = async <TPath extends DotPath<HoloConfigValues<TCustom>>>(
    path: TPath,
  ): Promise<ValueAtPath<HoloConfigValues<TCustom>, TPath>> => {
    const runtime = await resolveRuntime()
    return runtime.config(path)
  }

  const resolveRuntimeProjection = async () => {
    const runtime = await resolveRuntime()
    return {
      projectRoot: runtime.projectRoot,
      config: runtime.loadedConfig,
      registry: runtime.registry,
      runtime,
    }
  }

  return {
    async getApp() {
      return await resolveRuntimeProjection()
    },
    async getProject() {
      return await resolveRuntimeProjection()
    },
    async getSession() {
      const runtime = await resolveRuntime()
      return runtime.session
    },
    async getAuth() {
      const runtime = await resolveRuntime()
      return runtime.auth
    },
    useConfig,
    config: useConfig,
  }
}

const { serializeValidationException } = validationInternals

type ExpectedFailure = NonNullable<ReturnType<typeof serializeValidationException> | ReturnType<typeof serializeRateLimitError>>

function serializeExpectedFailure(error: unknown): ExpectedFailure {
  const payload = serializeValidationException(error) ?? serializeRateLimitError(error)
  if (!payload) throw error
  return payload
}

function routeHandler<TArgs extends readonly unknown[]>(handler: (...args: TArgs) => Response | Promise<Response>): (...args: TArgs) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      const payload = serializeExpectedFailure(error)
      return Response.json(payload, {
        status: payload.status,
        ...(payload.retryAfterSeconds === undefined ? {} : { headers: { 'Retry-After': String(payload.retryAfterSeconds) } }),
      })
    }
  }
}

const runningServerAction = new AsyncLocalStorage<true>()
function invokedServerActionRequest(action: object): NextWorkUnitStore | undefined {
  const actionStore = loadNextAsyncStorage<NextActionStore>(requireNextFromProject(), 'action')?.getStore()
  const store = currentWorkUnitStore()
  if (!actionStore?.isAction || actionStore.isAppRoute || store?.type !== 'request' || store.phase !== 'action') return undefined
  const invoked = store.headers?.get('next-action')
  return !invoked || invoked === Reflect.get(action, '$$id') ? store : undefined
}

function isSubmittedWithJavaScript(store: NextWorkUnitStore): boolean {
  return Boolean(store.headers?.get('next-action'))
}

type NextActionCookieStore = MutableNextCookieStore & {
  get(name: string): { value?: string } | undefined
  delete(name: string): void
}

async function actionCookies(): Promise<NextActionCookieStore> {
  const { cookies } = requireNextFromProject()('next/headers.js') as NextHeadersModule
  return await cookies() as NextActionCookieStore
}

async function flashValidationErrors(store: NextWorkUnitStore, failure: SerializedValidationException): Promise<void> {
  const flash = serializeValidationFlash({ bag: failure.bag, page: validationFlashPage(store.url?.pathname ?? '/'), errors: failure.errors })
  if (!flash) return
  rememberRenderedValidationFlash(store, flash)
  const cookies = await actionCookies()
  cookies.set(VALIDATION_FLASH_COOKIE, flash, {
    path: '/',
    sameSite: 'lax',
    secure: store.headers?.get('origin')?.startsWith('https:') ?? false,
  })
}

async function forgetValidationErrors(): Promise<void> {
  const cookies = await actionCookies()
  if (cookies.get(VALIDATION_FLASH_COOKIE)) cookies.delete(VALIDATION_FLASH_COOKIE)
}

function serverAction<TArgs extends readonly unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>): (...args: TArgs) => Promise<TResult | ExpectedFailure> {
  const invoke = async (...args: TArgs): Promise<TResult | ExpectedFailure> => {
    const request = runningServerAction.getStore() ? undefined : invokedServerActionRequest(invoke)
    if (!request) return await action(...args)
    await forgetValidationErrors()
    try {
      return await runningServerAction.run(true, () => action(...args))
    } catch (error) {
      const failure = serializeValidationException(error)
      if (failure) {
        await flashValidationErrors(request, failure)
        return failure
      }
      if (!isSubmittedWithJavaScript(request)) throw error
      return serializeExpectedFailure(error)
    }
  }
  return invoke
}

export const adapterNextRuntimeInternals = {
  routeHandler,
  serverAction,
  safeDecodeCookieSegment,
  parseResponseCookie,
  parseRequestCookies,
  isMissingNextRequestScope,
  resolveNextAuthRequestAccessors,
  createNextHttpAccessFallbackError,
}
