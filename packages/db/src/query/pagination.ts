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

  const trimmed = value.trim()
  if (typeof value !== 'string' || trimmed.length === 0) {
    throw createError(
      `${fallback === 'cursor' ? 'Cursor' : 'Page'} parameter name must be a non-empty string.`,
    )
  }

  return trimmed
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

export type CursorOrderDefinition = {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export type ValueCursor = {
  readonly values: readonly unknown[]
}

export function encodeValueCursor(values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify({ values }), 'utf8').toString('base64url')
}

export function decodeValueCursor(
  cursor: string | null,
  createError: PaginationErrorFactory,
): ValueCursor | null {
  if (cursor === null) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { values?: unknown }
    if (!Array.isArray(decoded.values)) {
      throw new Error('invalid cursor values')
    }

    return { values: decoded.values }
  } catch {
    throw createError('Cursor is malformed.')
  }
}

function normalizeComparableValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  return String(value)
}

function compareCursorValues(left: unknown, right: unknown): number {
  const normalizedLeft = normalizeComparableValue(left)
  const normalizedRight = normalizeComparableValue(right)

  if (normalizedLeft === normalizedRight) {
    return 0
  }

  if (normalizedLeft === null) {
    return -1
  }

  if (normalizedRight === null) {
    return 1
  }

  return normalizedLeft < normalizedRight ? -1 : 1
}

export function isRowAfterCursor(
  rowValues: readonly unknown[],
  cursorValues: readonly unknown[],
  orders: readonly CursorOrderDefinition[],
): boolean {
  for (const [index, order] of orders.entries()) {
    const comparison = compareCursorValues(rowValues[index], cursorValues[index])
    if (comparison === 0) {
      continue
    }

    return order.direction === 'asc' ? comparison > 0 : comparison < 0
  }

  return false
}
