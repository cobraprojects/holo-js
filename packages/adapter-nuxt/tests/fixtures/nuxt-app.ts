export function useCookie<TValue = string | null>(
  name: string,
): { value: TValue | null | undefined } {
  const cookie = (globalThis as { readonly document?: { readonly cookie?: string } }).document?.cookie
  if (!cookie) {
    return { value: undefined }
  }

  for (const segment of cookie.split(';')) {
    const trimmed = segment.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      continue
    }

    if (trimmed.slice(0, separator) === name) {
      return { value: trimmed.slice(separator + 1) as TValue }
    }
  }

  return { value: undefined }
}
