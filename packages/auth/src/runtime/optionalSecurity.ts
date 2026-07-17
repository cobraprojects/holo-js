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

const OPTIONAL_SECURITY_PACKAGE = '@holo-js/security'
type OptionalSecurityImporter = () => Promise<OptionalSecurityModule>
const defaultOptionalSecurityImporter: OptionalSecurityImporter = async () => await import('@holo-js/security' as string) as OptionalSecurityModule
let optionalSecurityImporter = defaultOptionalSecurityImporter

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
  return await optionalSecurityImporter()
    .catch(async (error) => {
      if (isMissingOptionalPackageError(error)) {
        return undefined
      }

      throw error
    })
}

export const optionalSecurityInternals = {
  isMissingOptionalPackageError,
  resetImporter(): void {
    optionalSecurityImporter = defaultOptionalSecurityImporter
  },
  setImporter(importer: OptionalSecurityImporter): void {
    optionalSecurityImporter = importer
  },
}
