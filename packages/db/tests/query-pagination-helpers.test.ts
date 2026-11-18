import { describe, expect, it } from 'vitest'
import { createSimplePaginator } from '../src/query/paginator'
import {
  assertPositiveInteger,
  decodeOffsetCursor,
  decodeValueCursor,
  encodeOffsetCursor,
  encodeValueCursor,
  normalizePaginationParameterName,
} from '../src/query/pagination'

function createError(message: string): Error {
  return new Error(message)
}

describe('@holo-js/db query pagination helpers', () => {
  it('validates pagination integers and parameter names', () => {
    expect(() => assertPositiveInteger(1, 'Limit', createError)).not.toThrow()
    expect(() => assertPositiveInteger(0, 'Limit', createError)).toThrow('Limit must be a positive integer.')
    expect(() => assertPositiveInteger(1.5, 'Limit', createError)).toThrow('Limit must be a positive integer.')

    expect(normalizePaginationParameterName(undefined, 'cursor', createError)).toBe('cursor')
    expect(normalizePaginationParameterName(' page ', 'page', createError)).toBe('page')
    expect(() => normalizePaginationParameterName('', 'cursor', createError)).toThrow(
      'Cursor parameter name must be a non-empty string.',
    )
    expect(() => normalizePaginationParameterName(' ', 'page', createError)).toThrow(
      'Page parameter name must be a non-empty string.',
    )
    expect(() => createSimplePaginator([], {
      perPage: 10,
      currentPage: 1,
      from: null,
      to: null,
      hasMorePages: false,
      pageName: '',
    })).toThrow('Page parameter name must be a non-empty string.')
  })

  it('encodes and decodes offset cursors and rejects malformed payloads', () => {
    expect(decodeOffsetCursor(null, createError)).toBe(0)
    expect(decodeOffsetCursor(encodeOffsetCursor(12), createError)).toBe(12)

    expect(() => decodeOffsetCursor('not-json', createError)).toThrow('Cursor is malformed.')
    expect(() => decodeOffsetCursor(
      Buffer.from(JSON.stringify({ offset: -1 }), 'utf8').toString('base64url'),
      createError,
    )).toThrow('Cursor is malformed.')
    expect(() => decodeOffsetCursor(
      Buffer.from(JSON.stringify({ offset: 1.5 }), 'utf8').toString('base64url'),
      createError,
    )).toThrow('Cursor is malformed.')
  })

  it('encodes and decodes value cursors and rejects malformed payloads', () => {
    const values = ['Ava', 1, null]

    expect(decodeValueCursor(null, createError)).toBeNull()
    expect(decodeValueCursor(encodeValueCursor(values), createError)).toEqual({ values })
    expect(() => decodeValueCursor('not-json', createError)).toThrow('Cursor is malformed.')
    expect(() => decodeValueCursor(
      Buffer.from(JSON.stringify({ values: 'Ava' }), 'utf8').toString('base64url'),
      createError,
    )).toThrow('Cursor is malformed.')
  })

  it('round-trips Date cursor values as Dates and rejects malformed ones', () => {
    const instant = new Date('2026-01-01T10:00:00.123Z')
    const encode = (values: unknown[]) => Buffer.from(JSON.stringify({ values }), 'utf8').toString('base64url')

    expect(decodeValueCursor(encodeValueCursor([instant, 'Ava']), createError)).toEqual({ values: [instant, 'Ava'] })
    expect(decodeValueCursor(encode(['2026-01-01T10:00:00.123Z']), createError)).toEqual({ values: ['2026-01-01T10:00:00.123Z'] })
    for (const value of [{ date: 'yesterday' }, { date: '2026-01-01' }, { date: 1 }, { date: '2026-01-01T10:00:00.123Z', extra: true }, {}, ['2026']]) {
      expect(() => decodeValueCursor(encode([value]), createError)).toThrow('Cursor is malformed.')
    }
  })
})
