import { describe, expect, it } from 'vitest'
import { compileDialectDefaultLiteral } from '../src'

describe('schema default literals', () => {
  it('serializes booleans with dialect-specific rules', () => {
    expect(compileDialectDefaultLiteral('sqlite', true)).toBe('1')
    expect(compileDialectDefaultLiteral('sqlite', false)).toBe('0')
    expect(compileDialectDefaultLiteral('postgres', true)).toBe('TRUE')
    expect(compileDialectDefaultLiteral('postgres', false)).toBe('FALSE')
    expect(compileDialectDefaultLiteral('mysql', true)).toBe('1')
    expect(compileDialectDefaultLiteral('mysql', false)).toBe('0')
  })

  it('serializes scalar, temporal, and object literals consistently', () => {
    expect(compileDialectDefaultLiteral('sqlite', 3.5)).toBe('3.5')
    expect(compileDialectDefaultLiteral('postgres', null)).toBe('NULL')
    expect(compileDialectDefaultLiteral('mysql', 'O\'Reilly')).toBe('\'O\'\'Reilly\'')
    expect(compileDialectDefaultLiteral('postgres', new Date('2025-01-02T03:04:05.000Z'))).toBe('\'2025-01-02T03:04:05.000Z\'')
    expect(compileDialectDefaultLiteral('mysql', { enabled: true, count: 2 })).toBe('\'{"enabled":true,"count":2}\'')
  })
})
