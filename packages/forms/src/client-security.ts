import { FormContractError } from './errors'
import {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  parseCookieHeader,
} from './security-shared'
import type { getSecurityClientConfig } from '@holo-js/security/client'

type SecurityClientModule = { readonly getSecurityClientConfig: typeof getSecurityClientConfig }

let securityClientModulePromise: Promise<SecurityClientModule> | undefined

type BrowserLikeGlobal = typeof globalThis & {
  document?: {
    cookie?: string
  }
}

export async function loadSecurityClientModule(): Promise<SecurityClientModule> {
  securityClientModulePromise ??= import('@holo-js/security/client')
    .catch((error: unknown) => {
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

async function loadInstalledSecurityClientModule(): Promise<SecurityClientModule | undefined> {
  try {
    return await loadSecurityClientModule()
  } catch (error) {
    if (error instanceof FormContractError) {
      return undefined
    }

    throw error
  }
}

export async function getClientCsrfConfig(): Promise<{ readonly field: string, readonly header: string }> {
  const config = (await loadInstalledSecurityClientModule())?.getSecurityClientConfig().csrf
  return { field: config?.field ?? '_token', header: config?.header ?? 'X-CSRF-TOKEN' }
}

export async function getClientCsrfField(): Promise<{ readonly name: string, readonly value: string } | undefined> {
  const runtime = globalThis as BrowserLikeGlobal

  if (!runtime.document || typeof runtime.document.cookie !== 'string') {
    return undefined
  }

  const security = await loadInstalledSecurityClientModule()
  if (!security) {
    return undefined
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
