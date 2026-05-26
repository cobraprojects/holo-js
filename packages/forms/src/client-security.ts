import { FormContractError } from './errors'
import {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  parseCookieHeader,
} from './security-shared'

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
  if (typeof process !== 'undefined' && process.env && process.env.VITEST) {
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

      if (isMissingOptionalPackageError(error)) {
        throw createMissingSecurityPackageError()
      }

      throw error
    })

  return await securityClientModulePromise
}

export function resetSecurityClientModuleCache(): void {
  securityClientModulePromise = undefined
}

export async function getClientCsrfField(): Promise<{ readonly name: string, readonly value: string } | undefined> {
  const runtime = globalThis as BrowserLikeGlobal

  if (!runtime.document || typeof runtime.document.cookie !== 'string') {
    return undefined
  }

  let security: SecurityClientModule
  try {
    security = await loadSecurityClientModule()
  } catch (error) {
    if (error instanceof FormContractError) {
      return undefined
    }

    throw error
  }
  const config = security.getSecurityClientConfig().csrf
  const value = parseCookieHeader(runtime.document.cookie)[config.cookie]

  if (!value) {
    return undefined
  }

  return Object.freeze({
    name: config.field,
    value,
  })
}

export const clientSecurityInternals = {
  resetSecurityClientModuleCache,
}
