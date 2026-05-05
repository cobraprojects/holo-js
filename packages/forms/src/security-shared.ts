import { FormContractError } from './errors'

export function isMissingOptionalPackageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return [
    /Cannot find package ['"]?@holo-js\/security['"]?/,
    /Cannot find module ['"]?@holo-js\/security['"]?/,
    /Failed to resolve module specifier ['"]?@holo-js\/security['"]?/,
    /Failed to load url ['"]?@holo-js\/security['"]?/,
    /Could not resolve ['"]?@holo-js\/security['"]?/,
  ].some(pattern => pattern.test(error.message))
}

export function createMissingSecurityPackageError(): FormContractError {
  return new FormContractError(
    '[@holo-js/forms] Security-aware form options require the optional @holo-js/security package to be installed.',
  )
}

export function parseCookieHeader(header: string): Readonly<Record<string, string>> {
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

export function isRootSecurityError(error: unknown): error is Error & { readonly status: number } {
  const candidate = error as { status?: unknown } | undefined

  return error instanceof Error
    && typeof candidate?.status === 'number'
    && (candidate.status === 419 || candidate.status === 429)
}
