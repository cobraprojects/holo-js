export const HOLO_FIELD_ERRORS: unique symbol = Symbol.for('holo-js.field-errors')

export type HoloFieldErrors = Readonly<Record<string, readonly string[]>>

export interface HoloFieldErrorsCarrier {
  readonly [HOLO_FIELD_ERRORS]: HoloFieldErrors
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function copyMessages(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const length: unknown = value.length
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) return undefined
  const messages: string[] = []
  for (let index = 0; index < length; index += 1) {
    const message: unknown = Object.hasOwn(value, index) ? value[index] : undefined
    if (typeof message !== 'string') return undefined
    messages.push(message)
  }
  return messages
}

function copyFieldErrors(value: unknown): HoloFieldErrors | undefined {
  if (!isPlainRecord(value)) return undefined
  const fieldErrors: Record<string, readonly string[]> = {}
  for (const [field, messages] of Object.entries(value)) {
    const copied = copyMessages(messages)
    if (!copied) return undefined
    Object.defineProperty(fieldErrors, field, { value: copied, enumerable: true })
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined
}

export function readHoloFieldErrors(value: unknown): HoloFieldErrors | undefined {
  if (!value || typeof value !== 'object') return undefined
  try {
    return copyFieldErrors(Reflect.get(value, HOLO_FIELD_ERRORS))
  } catch {
    return undefined
  }
}
