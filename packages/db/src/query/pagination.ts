type PaginationErrorFactory = (message: string) => Error

export function assertPositiveInteger(
  value: number,
  kind: string,
  createError: PaginationErrorFactory,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw createError(`${kind} must be a positive integer.`)
  }
}

export function normalizePaginationParameterName(
  value: string | undefined,
  fallback: string,
  createError: PaginationErrorFactory,
): string {
  if (typeof value === 'undefined') {
    return fallback
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createError(
      `${fallback === 'cursor' ? 'Cursor' : 'Page'} parameter name must be a non-empty string.`,
    )
  }

  return value
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function decodeOffsetCursor(
  cursor: string | null,
  createError: PaginationErrorFactory,
): number {
  if (cursor === null) {
    return 0
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    const offset = decoded.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new Error('invalid offset')
    }

    return offset
  } catch {
    throw createError('Cursor is malformed.')
  }
}
