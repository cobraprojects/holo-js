import {
  createMissingSecurityPackageError,
  isMissingOptionalPackageError,
  isRootSecurityError,
  parseCookieHeader,
} from './security-shared'
import type { rateLimit } from '@holo-js/security'

type SecurityModule = { readonly rateLimit: typeof rateLimit }

let securityModulePromise: Promise<SecurityModule> | undefined

export async function loadSecurityModule(): Promise<SecurityModule> {
  securityModulePromise ??= import('@holo-js/security')
    .catch((error: unknown) => {
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
