import { AsyncLocalStorage } from 'node:async_hooks'
import { createCookieWriteUnavailableError } from '@holo-js/kernel'

export interface AuthRequestAccessors {
  getCookie?(name: string): string | undefined | Promise<string | undefined>
  getHeader?(name: string): string | undefined | Promise<string | undefined>
  canAppendResponseCookie?(): boolean | Promise<boolean>
  appendResponseCookie?(cookie: string): void | Promise<void>
  redirectResponse?(url: string, status?: 301 | 302 | 303 | 307 | 308): void | Promise<void>
}

interface AuthContext {
  activate(): void
  adoptRequestScope?(): void
  getSessionId(guardName: string): string | undefined
  setSessionId(guardName: string, sessionId?: string): void
  getCachedUser(guardName: string): unknown
  setCachedUser(guardName: string, user: unknown): void
  getAccessToken?(guardName: string): string | undefined
  setAccessToken?(guardName: string, token?: string): void
  getRememberToken?(guardName: string): string | undefined
  setRememberToken?(guardName: string, token?: string): void
  run?<TValue>(callback: () => TValue): TValue
}

type RequestAwareContext<TContext extends AuthContext> = TContext & {
  getRequestCookie?(name: string): string | undefined | Promise<string | undefined>
  getRequestHeader?(name: string): string | undefined | Promise<string | undefined>
  canAppendResponseCookie?(): boolean | Promise<boolean>
  appendResponseCookie?(cookie: string): void | Promise<void>
  redirectResponse?(url: string, status?: 301 | 302 | 303 | 307 | 308): void | Promise<void>
}

function attachAuthRequestAccessors<TContext extends AuthContext>(
  context: TContext,
  accessors: AuthRequestAccessors,
): RequestAwareContext<TContext> {
  return Object.freeze({
    ...context,
    getRequestCookie: accessors.getCookie,
    getRequestHeader: accessors.getHeader,
    canAppendResponseCookie: accessors.canAppendResponseCookie,
    appendResponseCookie: accessors.appendResponseCookie,
    redirectResponse: accessors.redirectResponse,
  })
}

export function createRequestAwareAuthContext<TContext extends AuthContext>(
  context: TContext,
  accessors?: AuthRequestAccessors,
): RequestAwareContext<TContext> & {
  isRequestScoped(): boolean
  setRequestAccessors(accessors?: AuthRequestAccessors): void
  runWithRequestAccessors<TValue>(accessors: AuthRequestAccessors, callback: () => TValue): TValue
} {
  const requestAccessorStorage = new AsyncLocalStorage<{ readonly accessors?: AuthRequestAccessors, readonly requestScoped?: true }>()
  let defaultAccessors = accessors
  const resolveRequestContext = (): RequestAwareContext<TContext> => {
    const requestAccessors = requestAccessorStorage.getStore()
    const resolvedAccessors = requestAccessors ? requestAccessors.accessors : defaultAccessors
    return resolvedAccessors
      ? attachAuthRequestAccessors(context, resolvedAccessors)
      : context
  }

  return Object.freeze({
    ...context,
    getRequestCookie(name) {
      return resolveRequestContext().getRequestCookie?.(name)
    },
    getRequestHeader(name) {
      return resolveRequestContext().getRequestHeader?.(name)
    },
    canAppendResponseCookie() {
      const resolved = resolveRequestContext()
      return resolved.canAppendResponseCookie ? resolved.canAppendResponseCookie() : Boolean(resolved.appendResponseCookie)
    },
    appendResponseCookie(cookie) {
      const resolved = resolveRequestContext()
      if (!resolved.appendResponseCookie) {
        throw createCookieWriteUnavailableError('Authentication cookies cannot be set in this request context.')
      }
      return resolved.appendResponseCookie(cookie)
    },
    redirectResponse(url, status) {
      return resolveRequestContext().redirectResponse?.(url, status)
    },
    isRequestScoped() {
      return requestAccessorStorage.getStore()?.requestScoped === true
    },
    setRequestAccessors(nextAccessors) {
      const current = requestAccessorStorage.getStore()
      const previousAccessors = current ? current.accessors : defaultAccessors
      defaultAccessors = nextAccessors
      if (current?.requestScoped || previousAccessors === nextAccessors) return
      requestAccessorStorage.enterWith({ accessors: nextAccessors })
      context.adoptRequestScope?.()
    },
    runWithRequestAccessors(nextAccessors, callback) {
      return requestAccessorStorage.run(
        { accessors: nextAccessors, requestScoped: true },
        () => context.run ? context.run(callback) : callback(),
      )
    },
  })
}
