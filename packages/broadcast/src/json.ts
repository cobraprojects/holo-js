import type { BroadcastJsonValue } from './contracts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeJsonValue(
  value: unknown,
  path: string,
  formatError: (path: string) => string,
  options: {
    readonly validateKey?: (key: string, path: string) => void
  } = {},
): BroadcastJsonValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(formatError(path))
    }

    return value
  }

  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => normalizeJsonValue(entry, `${path}[${index}]`, formatError, options)))
  }

  if (!isPlainObject(value)) {
    throw new Error(formatError(path))
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      options.validateKey?.(key, path)
      return [key, normalizeJsonValue(entry, `${path}.${key}`, formatError, options)] as const
    }),
  ))
}

export function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`[@holo-js/broadcast] ${label} must be valid JSON.`)
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a JSON object.`)
  }

  return parsed
}
