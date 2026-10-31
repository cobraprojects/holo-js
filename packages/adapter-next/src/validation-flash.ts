export { VALIDATION_FLASH_COOKIE } from './validation-flash-cookie'

const MAX_FLASH_COOKIE_BYTES = 3_800

export type ValidationFlash = {
  readonly bag: string
  readonly page: string
  readonly errors: Readonly<Record<string, readonly string[]>>
}

function isMessages(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(message => typeof message === 'string')
}

function isErrors(value: unknown): value is ValidationFlash['errors'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isMessages)
}

export function parseValidationFlash(value: string): ValidationFlash | undefined {
  if (!value) return undefined
  try {
    const flash: unknown = JSON.parse(value)
    if (typeof flash !== 'object' || flash === null) return undefined
    const { bag, page, errors } = flash as Record<string, unknown>
    return typeof bag === 'string' && typeof page === 'string' && isErrors(errors) ? { bag, page, errors } : undefined
  } catch {
    return undefined
  }
}

export function validationFlashPage(pathname: string): string {
  let hash = 0x811c9dc5
  for (const character of pathname) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function fitsInCookie(flash: ValidationFlash): boolean {
  return encodeURIComponent(JSON.stringify(flash)).length <= MAX_FLASH_COOKIE_BYTES
}

function firstMessages(errors: ValidationFlash['errors']): ValidationFlash['errors'] {
  return Object.fromEntries(Object.entries(errors).map(([path, messages]) => [path, messages.slice(0, 1)]))
}

export function serializeValidationFlash(flash: ValidationFlash): string | undefined {
  if (fitsInCookie(flash)) return JSON.stringify(flash)
  if (!fitsInCookie({ ...flash, errors: {} })) return undefined
  const errors: Record<string, readonly string[]> = {}
  for (const [path, messages] of Object.entries(firstMessages(flash.errors))) {
    if (fitsInCookie({ ...flash, errors: { ...errors, [path]: messages } })) errors[path] = messages
  }
  return JSON.stringify({ ...flash, errors })
}
