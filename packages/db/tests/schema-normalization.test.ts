import { describe, expect, it } from 'vitest'
import {
  CapabilityError,
  DIALECT_VECTOR_SUPPORT,
  HydrationError,
  column,
  normalizeDialectReadValue,
  normalizeDialectWriteValue } from '../src'

describe('schema normalization rules', () => {
  it('normalizes boolean, json, and timestamp values on reads and writes across dialects', () => {
    const booleanColumn = column.boolean().toDefinition({ name: 'active' })
    const jsonColumn = column.json<{ enabled: boolean }>().toDefinition({ name: 'settings' })
    const dateColumn = column.date().toDefinition({ name: 'birthday' })
    const datetimeColumn = column.datetime().toDefinition({ name: 'publishedAt' })
    const timestampColumn = column.timestamp().toDefinition({ name: 'createdAt' })
    const stringColumn = column.string().toDefinition({ name: 'name' })

    expect(normalizeDialectReadValue('sqlite', booleanColumn, true)).toBe(true)
    expect(normalizeDialectReadValue('sqlite', booleanColumn, 1)).toBe(true)
    expect(normalizeDialectReadValue('mysql', booleanColumn, '1')).toBe(true)
    expect(normalizeDialectReadValue('mysql', booleanColumn, '0')).toBe(false)
    expect(normalizeDialectReadValue('mysql', booleanColumn, 'false')).toBe(false)
    expect(normalizeDialectReadValue('postgres', booleanColumn, 't')).toBe(true)
    expect(normalizeDialectReadValue('postgres', booleanColumn, 'f')).toBe(false)
    expect(normalizeDialectReadValue('postgres', booleanColumn, { enabled: true })).toBe(true)
    expect(normalizeDialectReadValue('postgres', booleanColumn, null)).toBeNull()
    expect(normalizeDialectWriteValue('sqlite', booleanColumn, true)).toBe(1)
    expect(normalizeDialectWriteValue('sqlite', booleanColumn, 'false')).toBe(0)
    expect(normalizeDialectWriteValue('mysql', booleanColumn, '0')).toBe(0)
    expect(normalizeDialectWriteValue('mysql', booleanColumn, false)).toBe(0)
    expect(normalizeDialectWriteValue('sqlite', booleanColumn, null)).toBeNull()
    expect(normalizeDialectWriteValue('postgres', booleanColumn, true)).toBe(true)
    expect(normalizeDialectWriteValue('postgres', booleanColumn, 'false')).toBe(false)
    expect(normalizeDialectWriteValue('postgres', booleanColumn, null)).toBeNull()

    expect(normalizeDialectReadValue('postgres', jsonColumn, '{"enabled":true}')).toEqual({ enabled: true })
    expect(normalizeDialectReadValue('postgres', jsonColumn, { enabled: true })).toEqual({ enabled: true })
    expect(normalizeDialectWriteValue('sqlite', jsonColumn, { enabled: true })).toBe('{"enabled":true}')
    expect(normalizeDialectWriteValue('mysql', jsonColumn, '{"enabled":true}')).toBe('{"enabled":true}')
    expect(normalizeDialectWriteValue('mysql', jsonColumn, null)).toBeNull()

    const date = new Date('2025-01-02T03:04:05.000Z')
    expect(normalizeDialectReadValue('postgres', dateColumn, '2025-01-02')).toEqual(new Date('2025-01-02'))
    expect(normalizeDialectWriteValue('postgres', dateColumn, date)).toBe('2025-01-02T03:04:05.000Z')
    expect(normalizeDialectWriteValue('postgres', datetimeColumn, '2025-01-02 03:04:05')).toBe('2025-01-02 03:04:05')
    expect(normalizeDialectReadValue('postgres', timestampColumn, '2025-01-02T03:04:05.000Z')).toEqual(date)
    expect(normalizeDialectReadValue('postgres', timestampColumn, date)).toBe(date)
    expect(normalizeDialectWriteValue('postgres', timestampColumn, date)).toBe('2025-01-02T03:04:05.000Z')
    expect(normalizeDialectWriteValue('postgres', timestampColumn, '2025-01-02T03:04:05.000Z')).toBe('2025-01-02T03:04:05.000Z')

    expect(normalizeDialectReadValue('sqlite', stringColumn, 'Mohamed')).toBe('Mohamed')
    expect(normalizeDialectReadValue('mysql', stringColumn, 'Mohamed')).toBe('Mohamed')
    expect(normalizeDialectReadValue('postgres', stringColumn, { value: 'Mohamed' })).toEqual({ value: 'Mohamed' })
    expect(normalizeDialectWriteValue('sqlite', stringColumn, 'Mohamed')).toBe('Mohamed')
    expect(normalizeDialectWriteValue('mysql', stringColumn, 'Mohamed')).toBe('Mohamed')
    expect(normalizeDialectWriteValue('postgres', stringColumn, { value: 'Mohamed' })).toEqual({ value: 'Mohamed' })
  })

  it('defines vector support explicitly and normalizes vectors only for supporting dialects', () => {
    const vectorColumn = column.vector({ dimensions: 3 }).toDefinition({ name: 'embedding' })

    expect(DIALECT_VECTOR_SUPPORT).toEqual({
      sqlite: false,
      postgres: true,
      mysql: false })

    expect(normalizeDialectReadValue('postgres', vectorColumn, '[1,2,3]')).toEqual([1, 2, 3])
    expect(normalizeDialectReadValue('postgres', vectorColumn, [1, 2, 3])).toEqual([1, 2, 3])
    expect(normalizeDialectReadValue('postgres', vectorColumn, null)).toBeNull()
    expect(normalizeDialectWriteValue('postgres', vectorColumn, [1, 2, 3])).toBe('[1,2,3]')
    expect(normalizeDialectWriteValue('postgres', vectorColumn, null)).toBeNull()

    expect(() => normalizeDialectReadValue('sqlite', vectorColumn, '[1,2,3]')).toThrow(CapabilityError)
    expect(() => normalizeDialectReadValue('mysql', vectorColumn, '[1,2,3]')).toThrow(CapabilityError)
    expect(() => normalizeDialectWriteValue('sqlite', vectorColumn, [1, 2, 3])).toThrow(CapabilityError)
    expect(() => normalizeDialectWriteValue('mysql', vectorColumn, [1, 2, 3])).toThrow(CapabilityError)
  })

  it('fails closed for malformed vector payloads', () => {
    const vectorColumn = column.vector({ dimensions: 3 }).toDefinition({ name: 'embedding' })

    expect(() => normalizeDialectReadValue('postgres', vectorColumn, '   ')).toThrow(HydrationError)
    expect(() => normalizeDialectReadValue('postgres', vectorColumn, '[')).toThrow(HydrationError)
    expect(() => normalizeDialectReadValue('postgres', vectorColumn, '{"x":1}')).toThrow(HydrationError)
    expect(() => normalizeDialectReadValue('postgres', vectorColumn, 123)).toThrow(HydrationError)
    expect(() => normalizeDialectWriteValue('postgres', vectorColumn, ['a', 2, 3])).toThrow(HydrationError)
    expect(() => normalizeDialectWriteValue('postgres', vectorColumn, 123)).toThrow(HydrationError)
  })
})
