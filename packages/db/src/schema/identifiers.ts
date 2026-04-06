import { SchemaError } from '../core/errors'

const IDENTIFIER_SEGMENT_PATTERN = /^[A-Z_]\w*$/i

export function assertValidIdentifierSegment(identifier: string, context: string): void {
  if (!IDENTIFIER_SEGMENT_PATTERN.test(identifier)) {
    throw new SchemaError(`${context} must be a valid SQL identifier segment.`)
  }
}

export function assertValidIdentifierPath(identifier: string, context: string): void {
  if (!identifier.trim()) {
    throw new SchemaError(`${context} must not be empty.`)
  }

  const segments = identifier.split('.')
  if (segments.some(segment => !segment.trim())) {
    throw new SchemaError(`${context} must not contain empty identifier segments.`)
  }

  for (const segment of segments) {
    assertValidIdentifierSegment(segment, context)
  }
}

export function sanitizeIdentifierForGeneratedName(identifier: string): string {
  return identifier.replaceAll('.', '_')
}
