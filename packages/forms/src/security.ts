import { FormContractError } from './contracts'

type SecurityModule = {
  csrf: {
    verify(request: Request): Promise<void>
  }
  rateLimit(name: string, options: { readonly request?: Request, readonly key?: string, readonly values?: Readonly<Record<string, unknown>> }): Promise<unknown>
}

type SecurityClientModule = {
  getSecurityClientConfig(): {
    readonly csrf: {
      readonly field: string
      readonly cookie: string
    }
  }
}

let securityModulePromise: Promise<SecurityModule> | undefined
let securityClientModulePromise: Promise<SecurityClientModule> | undefined

type BrowserLikeGlobal = typeof globalThis & {
  document?: {
    cookie?: string
  }
  __holoFormsSecurityModule__?: SecurityModule
  __holoFormsSecurityClientModule__?: SecurityClientModule
  __holoFormsSecurityImport__?: () => Promise<unknown>
  __holoFormsSecurityClientImport__?: () => Promise<unknown>
}

function isMissingOptionalPackageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.includes('Cannot find package')
    || error.message.includes('Cannot find module')
    || error.message.includes('Failed to resolve module specifier')
    || error.message.includes('Failed to load url')
    || error.message.includes('Could not resolve')
}

function createMissingSecurityPackageError(): FormContractError {
  return new FormContractError(
    '[@holo-js/forms] Security-aware form options require the optional @holo-js/security package to be installed.',
  )
}

export async function loadSecurityModule(): Promise<SecurityModule> {
  const runtime = globalThis as BrowserLikeGlobal
  if (runtime.__holoFormsSecurityModule__) {
    return runtime.__holoFormsSecurityModule__
  }

  securityModulePromise ??= (runtime.__holoFormsSecurityImport__
    ? runtime.__holoFormsSecurityImport__()
    : import('@holo-js/security'))
    .then(module => module as SecurityModule)
    .catch(async (error) => {
      securityModulePromise = undefined

      if (isMissingOptionalPackageError(error)) {
        throw createMissingSecurityPackageError()
      }

      throw error
    })

  return await securityModulePromise
}

export async function loadSecurityClientModule(): Promise<SecurityClientModule> {
  const runtime = globalThis as BrowserLikeGlobal
  if (runtime.__holoFormsSecurityClientModule__) {
    return runtime.__holoFormsSecurityClientModule__
  }

  securityClientModulePromise ??= (runtime.__holoFormsSecurityClientImport__
    ? runtime.__holoFormsSecurityClientImport__()
    : import('@holo-js/security/client'))
    .then(module => module as SecurityClientModule)
    .catch(async (error) => {
      securityClientModulePromise = undefined

      if (isMissingOptionalPackageError(error)) {
        throw createMissingSecurityPackageError()
      }

      throw error
    })

  return await securityClientModulePromise
}

export function resetSecurityModuleCache(): void {
  securityModulePromise = undefined
  securityClientModulePromise = undefined
}

function parseCookieHeader(header: string): Readonly<Record<string, string>> {
  const decodeCookiePart = (value: string): string | undefined => {
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }

  return Object.freeze(Object.fromEntries(
    header
      .split(';')
      .map(segment => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        const separator = segment.indexOf('=')
        if (separator <= 0) {
          return undefined
        }

        const key = decodeCookiePart(segment.slice(0, separator))
        const value = decodeCookiePart(segment.slice(separator + 1))
        if (!key || typeof value === 'undefined') {
          return undefined
        }

        return [
          key,
          value,
        ] as const
      })
      .filter((entry): entry is readonly [string, string] => !!entry),
  ))
}

function isRootSecurityError(error: unknown): error is Error & { readonly status: number } {
  const candidate = error as { status?: unknown } | undefined

  return error instanceof Error
    && typeof candidate?.status === 'number'
    && (candidate.status === 419 || candidate.status === 429)
}

export async function getClientCsrfField(): Promise<{ readonly name: string, readonly value: string }> {
  const runtime = globalThis as BrowserLikeGlobal

  if (!runtime.document || typeof runtime.document.cookie !== 'string') {
    throw new FormContractError(
      '[@holo-js/forms] useForm({ csrf: true }) requires a browser-like document.cookie environment.',
    )
  }

  const security = await loadSecurityClientModule()
  const config = security.getSecurityClientConfig().csrf
  const value = parseCookieHeader(runtime.document.cookie)[config.cookie]

  if (!value) {
    throw new FormContractError(
      `[@holo-js/forms] Missing CSRF cookie "${config.cookie}" required by useForm({ csrf: true }).`,
    )
  }

  return Object.freeze({
    name: config.field,
    value,
  })
}

export const formsSecurityInternals = {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  isRootSecurityError,
  parseCookieHeader,
  resetSecurityModuleCache,
}
