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
  const mentionsSecurityPackage = message.includes('@holo-js/security')

  return mentionsSecurityPackage && (
    message.includes('Cannot find package')
    || message.includes('Cannot find module')
    || message.includes('Failed to resolve module specifier')
    || message.includes('Failed to load url')
    || message.includes('Could not resolve')
  )
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
