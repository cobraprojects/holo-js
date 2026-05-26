import {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  isRootSecurityError,
  parseCookieHeader,
} from './security-shared'

type SecurityModule = {
  rateLimit(name: string, options: { readonly request?: Request, readonly key?: string, readonly values?: Readonly<Record<string, unknown>> }): Promise<unknown>
}

let securityModulePromise: Promise<SecurityModule> | undefined

type BrowserLikeGlobal = typeof globalThis & {
  __holoFormsSecurityModule__?: SecurityModule
  __holoFormsSecurityImport__?: () => Promise<unknown>
}

async function importSecurityModule(): Promise<SecurityModule> {
  if (typeof process !== 'undefined' && process.env && process.env.VITEST) {
    return await import(/* @vite-ignore */ '@holo-js/security')
  }

  return await import('@holo-js/security')
}

export async function loadSecurityModule(): Promise<SecurityModule> {
  const runtime = globalThis as BrowserLikeGlobal
  if (runtime.__holoFormsSecurityModule__) {
    return runtime.__holoFormsSecurityModule__
  }

  securityModulePromise ??= (runtime.__holoFormsSecurityImport__
    ? runtime.__holoFormsSecurityImport__()
    : importSecurityModule())
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

export function resetSecurityModuleCache(): void {
  securityModulePromise = undefined
}

export const formsSecurityInternals = {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  isRootSecurityError,
  parseCookieHeader,
  resetSecurityModuleCache,
}
