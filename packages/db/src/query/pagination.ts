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
  readonly previous?: boolean
}

export function encodeValueCursor(values: readonly unknown[], previous = false): string {
  if (values.some(value => value === undefined)) throw new Error('Cursor pagination requires selected orderBy columns.')
  if (values.some(value => value !== null && typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'bigint' && !(typeof value === 'number' && Number.isFinite(value)) && !(value instanceof Date && Number.isFinite(value.getTime())))) throw new Error('Cursor pagination requires scalar orderBy values.')
  const serializedValues = values.map(value => typeof value === 'bigint' ? value.toString() : value)
  return Buffer.from(JSON.stringify({ values: serializedValues, ...(previous ? { previous: true } : {}) }), 'utf8').toString('base64url')
}

export function decodeValueCursor(
  cursor: string | null,
  createError: PaginationErrorFactory,
): ValueCursor | null {
  if (cursor === null) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { values?: unknown, previous?: unknown }
    if (!Array.isArray(decoded.values) || decoded.values.some(value => value !== null && typeof value !== 'string' && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) || decoded.previous !== undefined && typeof decoded.previous !== 'boolean') {
      throw new Error('invalid cursor values')
    }

    return { values: decoded.values, ...(decoded.previous === true ? { previous: true } : {}) }
  } catch {
    throw createError('Cursor is malformed.')
  }
}
