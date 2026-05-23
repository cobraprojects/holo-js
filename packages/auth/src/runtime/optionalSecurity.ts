export type OptionalSecurityRateLimitStore = {
  hit(
    key: string,
    options: { readonly maxAttempts: number, readonly decaySeconds: number },
  ): Promise<{ readonly limited: boolean }>
  clear?(key: string): Promise<boolean>
}

export type OptionalSecurityModule = {
  getSecurityRuntimeBindings?(): {
    readonly rateLimitStore?: OptionalSecurityRateLimitStore
    readonly csrfSigningKey?: string
  } | undefined
}

let optionalSecurityModulePromise: Promise<OptionalSecurityModule | undefined> | undefined
const OPTIONAL_SECURITY_PACKAGE = '@holo-js/security'

function getOptionalSecurityModuleOverride(): OptionalSecurityModule | undefined {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthSecurityModule__?: OptionalSecurityModule
  }

  return runtime.__holoAuthSecurityModule__
}

function getOptionalSecurityImportOverride(): (() => Promise<unknown>) | undefined {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthSecurityImport__?: () => Promise<unknown>
  }

  return runtime.__holoAuthSecurityImport__
}

function isMissingOptionalPackageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message
  const code = (error as Error & { readonly code?: unknown }).code
  const quotedPackage = String.raw`["']${OPTIONAL_SECURITY_PACKAGE}["']`
  const missingPackage = new RegExp(String.raw`Cannot find package ${quotedPackage}`).test(message)
  const missingModule = new RegExp(String.raw`Cannot find module ${quotedPackage}`).test(message)
  const unresolvedSpecifier = new RegExp(String.raw`(?:Failed to resolve module specifier|Could not resolve) ${quotedPackage}`).test(message)
  const failedLoadUrl = new RegExp(String.raw`Failed to load url ${OPTIONAL_SECURITY_PACKAGE}(?:\b|[/?#])`).test(message)

  if (
    (missingPackage || missingModule)
    && (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
  ) {
    return true
  }

  return missingPackage || missingModule || unresolvedSpecifier || failedLoadUrl
}

export async function loadOptionalSecurityModule(): Promise<OptionalSecurityModule | undefined> {
  const override = getOptionalSecurityModuleOverride()
  if (override) {
    return override
  }

  const importOverride = getOptionalSecurityImportOverride()
  optionalSecurityModulePromise ??= (importOverride
    ? importOverride()
    : import('@holo-js/security' as string))
    .then(module => module as OptionalSecurityModule)
    .catch(async (error) => {
      optionalSecurityModulePromise = undefined

      if (isMissingOptionalPackageError(error)) {
        return undefined
      }

      throw error
    })

  return await optionalSecurityModulePromise
}

export function resetOptionalSecurityModuleCache(): void {
  optionalSecurityModulePromise = undefined
}
