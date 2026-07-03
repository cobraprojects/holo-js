import { stableStringify } from '../runtime/stable-stringify'

export { stableStringify }

export function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {}
  }

  return args as Record<string, unknown>
}

export function createStoreKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`
}

export function parseRealtimeJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return parsed as Record<string, unknown>
}

export function parseWireData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return parseRealtimeJsonObject(value)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}
