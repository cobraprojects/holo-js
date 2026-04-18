import { FormContractError } from './contracts'
import { formsSecurityInternals } from './security'

type SecurityClientModule = {
  getSecurityClientConfig(): {
    readonly csrf: {
      readonly field: string
      readonly cookie: string
    }
  }
}

let securityClientModulePromise: Promise<SecurityClientModule> | undefined

type BrowserLikeGlobal = typeof globalThis & {
  document?: {
    cookie?: string
  }
  __holoFormsSecurityClientModule__?: SecurityClientModule
  __holoFormsSecurityClientImport__?: () => Promise<unknown>
}

async function importSecurityClientModule(): Promise<SecurityClientModule> {
  if (process.env.VITEST) {
    return await import(/* @vite-ignore */ '@holo-js/security/client')
  }

  return await import('@holo-js/security/client')
}

export async function loadSecurityClientModule(): Promise<SecurityClientModule> {
  const runtime = globalThis as BrowserLikeGlobal
  if (runtime.__holoFormsSecurityClientModule__) {
    return runtime.__holoFormsSecurityClientModule__
  }

  securityClientModulePromise ??= (runtime.__holoFormsSecurityClientImport__
    ? runtime.__holoFormsSecurityClientImport__()
    : importSecurityClientModule())
    .then(module => module as SecurityClientModule)
    .catch(async (error) => {
      securityClientModulePromise = undefined

      if (formsSecurityInternals.isMissingOptionalPackageError(error)) {
        throw formsSecurityInternals.createMissingSecurityPackageError()
      }

      throw error
    })

  return await securityClientModulePromise
}

export function resetSecurityClientModuleCache(): void {
  securityClientModulePromise = undefined
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
  const value = formsSecurityInternals.parseCookieHeader(runtime.document.cookie)[config.cookie]

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

export const clientSecurityInternals = {
  resetSecurityClientModuleCache,
}
