import { InvalidCursorException } from '../core/errors'
import type { CursorPaginationOptions } from './types'

type PaginationErrorFactory = (message: string) => Error
type InvalidCursorFactory = () => InvalidCursorException

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

  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) {
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
  const serializedValues = values.map(value => typeof value === 'bigint' ? { bigint: value.toString() } : value)
  return Buffer.from(JSON.stringify({ values: serializedValues, ...(previous ? { previous: true } : {}) }), 'utf8').toString('base64url')
}

const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export type ResolvedCursorPaginationOptions = {
  readonly cursorName: string
  readonly invalidCursor: InvalidCursorFactory
}

export function resolveCursorPaginationOptions(
  options: CursorPaginationOptions,
  createError: PaginationErrorFactory,
): ResolvedCursorPaginationOptions {
  const cursorName = normalizePaginationParameterName(options.cursorName, 'cursor', createError)
  if (cursorName.split('.').some(segment => RESERVED_FIELD_NAMES.has(segment.trim()))) {
    throw createError(`Cursor parameter name cannot use "__proto__", "constructor" or "prototype".`)
  }
  const message = options.invalidCursorMessage
  if (message !== undefined && (typeof message !== 'string' || message.trim().length === 0)) {
    throw createError('Invalid cursor message must be a non-empty string.')
  }

  return {
    cursorName,
    invalidCursor: () => new InvalidCursorException(cursorName, message),
  }
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeCanonicalBase64Url(token: string): string {
  const bytes = BASE64URL_PATTERN.test(token) ? Buffer.from(token, 'base64url') : undefined
  if (!bytes || bytes.toString('base64url') !== token) throw new Error('invalid cursor encoding')
  return UTF8_DECODER.decode(bytes)
}

const BIGINT_CURSOR_VALUE = /^-?(0|[1-9]\d*)$/

function decodeCursorValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1) {
    const bigint: unknown = Reflect.get(value, 'bigint')
    if (typeof bigint === 'string' && BIGINT_CURSOR_VALUE.test(bigint)) return BigInt(bigint)
  }
  throw new Error('invalid cursor value')
}

export function decodeValueCursor(
  cursor: string | null,
  invalidCursor: InvalidCursorFactory,
): ValueCursor | null {
  if (cursor === null) {
    return null
  }

  try {
    const decoded = JSON.parse(decodeCanonicalBase64Url(cursor)) as { values?: unknown, previous?: unknown }
    if (!Array.isArray(decoded.values) || decoded.previous !== undefined && typeof decoded.previous !== 'boolean') {
      throw new Error('invalid cursor values')
    }

    return { values: decoded.values.map(decodeCursorValue), ...(decoded.previous === true ? { previous: true } : {}) }
  } catch {
    throw invalidCursor()
  }
}
