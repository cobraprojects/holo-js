import { describe, expect, it } from 'vitest'
import { isUniqueConstraintError } from '../src/model/constraintErrors'

describe('unique constraint errors', () => {
  it.each(['23505', 1062, '1062', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'])(
    'recognizes driver code %s',
    (code) => expect(isUniqueConstraintError({ code })).toBe(true),
  )

  it('walks causes and recognizes messages', () => {
    expect(isUniqueConstraintError(new Error('duplicate entry'))).toBe(true)
    expect(isUniqueConstraintError({ cause: new Error('unique constraint failed') })).toBe(true)
    expect(isUniqueConstraintError({ code: 'OTHER', cause: null })).toBe(false)
    expect(isUniqueConstraintError(undefined)).toBe(false)
  })
})
