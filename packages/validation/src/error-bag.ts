import { type ValidationErrorBag, ValidationContractError } from './contracts-types'

// The error bag on its own, so browser code that only shows errors doesn't load the validator.

export const DEFAULT_VALIDATION_BAG = 'default'

export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function createObjectContainer(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

export function hasOwnContainerValue(container: Record<string, unknown> | unknown[], key: string | number): boolean {
  return Object.prototype.hasOwnProperty.call(container, key)
}

function assertSafePathSegment(segment: string, path: string): void {
  if (UNSAFE_PATH_SEGMENTS.has(segment)) {
    throw new ValidationContractError(`Unsafe path segment "${segment}" in "${path}".`)
  }
}

function pathSegments(path: string): readonly string[] {
  const segments = path.split('.').map(segment => segment.trim()).filter(Boolean)
  for (const segment of segments) {
    assertSafePathSegment(segment, path)
  }

  return segments
}

export function buildErrorTree(flattened: Record<string, readonly string[]>): Record<string, unknown> {
  const root = createObjectContainer()

  for (const [path, messages] of Object.entries(flattened)) {
    const segments = pathSegments(path)
    if (segments.length === 0) {
      continue
    }

    let cursor: Record<string, unknown> = root
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        cursor[segment] = Object.freeze([...messages])
        continue
      }

      const existing = hasOwnContainerValue(cursor, segment) ? cursor[segment] : undefined
      if (!isPlainObject(existing)) {
        cursor[segment] = createObjectContainer()
      }

      cursor = cursor[segment] as Record<string, unknown>
    }
  }

  return root
}

export function createErrorBag<TShape>(
  flattened: Record<string, readonly string[]> = {},
): ValidationErrorBag<TShape> {
  const normalized = Object.freeze(Object.fromEntries(
    Object.entries(flattened).map(([key, messages]) => [key, Object.freeze([...messages])]),
  )) as Record<string, readonly string[]>
  const tree = buildErrorTree(normalized)

  return Object.freeze(Object.assign(tree, {
    has(path: string) {
      return Boolean(normalized[path]?.length)
    },
    get(path: string) {
      return normalized[path] ?? Object.freeze([])
    },
    first(path: string) {
      return normalized[path]?.[0]
    },
    flatten() {
      return normalized
    },
    toJSON() {
      return normalized
    },
  })) as ValidationErrorBag<TShape>
}
