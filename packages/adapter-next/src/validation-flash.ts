export const VALIDATION_FLASH_COOKIE = 'holo_form_failure'

const MAX_FLASH_COOKIE_BYTES = 3_800

export type ValidationFlash = {
  readonly bag: string
  readonly path: string
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
    const { bag, path, errors } = flash as Record<string, unknown>
    return typeof bag === 'string' && typeof path === 'string' && isErrors(errors) ? { bag, path, errors } : undefined
  } catch {
    return undefined
  }
}

function fitsInCookie(flash: ValidationFlash): boolean {
  return encodeURIComponent(JSON.stringify(flash)).length <= MAX_FLASH_COOKIE_BYTES
}

function firstMessages(errors: ValidationFlash['errors']): ValidationFlash['errors'] {
  return Object.fromEntries(Object.entries(errors).map(([path, messages]) => [path, messages.slice(0, 1)]))
}

export function serializeValidationFlash(flash: ValidationFlash): string {
  if (fitsInCookie(flash)) return JSON.stringify(flash)
  const errors: Record<string, readonly string[]> = {}
  for (const [path, messages] of Object.entries(firstMessages(flash.errors))) {
    if (fitsInCookie({ ...flash, errors: { ...errors, [path]: messages } })) errors[path] = messages
  }
  return JSON.stringify({ ...flash, errors })
}
