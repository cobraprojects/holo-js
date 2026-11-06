import { describe, expect, it } from 'vitest'
import { createDialect, holoRuntimeInternals } from '../src'

const { quoteTablePath } = holoRuntimeInternals

describe('quoteTablePath', () => {
  it.each([
    ['sqlite', 'items', '"items"'],
    ['sqlite', 'archive.items', '"archive"."items"'],
    ['postgres', 'users', '"users"'],
    ['postgres', 'public.users', '"public"."users"'],
    ['mysql', 'users', '`users`'],
    ['mysql', 'app.users', '`app`.`users`'],
  ] as const)('quotes each segment of a %s table path', (driver, path, expected) => {
    expect(quoteTablePath(createDialect(driver), path)).toBe(expected)
  })

  it('keeps the SQLite identifier quoter atomic so dotted identifiers survive', () => {
    const dialect = createDialect('sqlite')

    expect(dialect.quoteIdentifier('price.summary')).toBe('"price.summary"')
    expect(quoteTablePath(dialect, 'price.summary')).toBe('"price"."summary"')
  })
})
