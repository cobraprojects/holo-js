import { describe, expect, it } from 'vitest'
import { SQLiteQueryCompiler, createDialect, createTableSource, holoRuntimeInternals } from '../src'
import { createTruncateQueryPlan } from '../src/query/ast'

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

  it('quotes a dotted SQLite attached database name as one segment', () => {
    expect(quoteTablePath(createDialect('sqlite'), 'my.db.items')).toBe('"my.db"."items"')
  })
})

describe('dialect quoteIdentifier', () => {
  it.each([
    ['sqlite', 'we"ird', '"we""ird"'],
    ['postgres', 'we"ird', '"we""ird"'],
    ['postgres', 'public.we"ird', '"public"."we""ird"'],
    ['mysql', 'we`ird', '`we``ird`'],
    ['mysql', 'app.we`ird', '`app`.`we``ird`'],
  ] as const)('escapes embedded quotes on %s for %s', (driver, identifier, expected) => {
    expect(createDialect(driver).quoteIdentifier(identifier)).toBe(expected)
  })

  it.each([
    ['sqlite', 'a"; DROP TABLE users; --', '"a""; DROP TABLE users; --"'],
    ['postgres', 'a"; DROP TABLE users; --', '"a""; DROP TABLE users; --"'],
    ['mysql', 'a`; DROP TABLE users; --', '`a``; DROP TABLE users; --`'],
  ] as const)('keeps an injected %s identifier inside its quotes', (driver, identifier, expected) => {
    expect(createDialect(driver).quoteIdentifier(identifier)).toBe(expected)
  })
})

describe('compileResolvedTruncate', () => {
  const dialect = createDialect('sqlite')
  const compiler = new SQLiteQueryCompiler(identifier => dialect.quoteIdentifier(identifier), () => '?')
  const plan = createTruncateQueryPlan(createTableSource('ledger'))

  it('quotes a dotted resolved attached database as one segment', () => {
    expect(compiler.compileResolvedTruncate(plan, 'my.db.ledger').sql).toBe('DELETE FROM "my.db"."ledger"')
  })

  it.each(['other', 'my.db.other', 'xledger', 'my.dbledger'])('rejects resolved table %s that is not the requested table', (tableName) => {
    expect(() => compiler.compileResolvedTruncate(plan, tableName)).toThrow('Resolved table')
  })

  it.each(['other.main.ledger', 'main.ledger.x', 'ledger'])('rejects resolved table %s for the qualified request main.ledger', (tableName) => {
    const qualified = createTruncateQueryPlan(createTableSource('main.ledger'))
    expect(() => compiler.compileResolvedTruncate(qualified, tableName)).toThrow('Resolved table')
  })

  it('compiles a qualified request that resolves to itself', () => {
    const qualified = createTruncateQueryPlan(createTableSource('main.ledger'))
    expect(compiler.compileResolvedTruncate(qualified, 'main.ledger').sql).toBe('DELETE FROM "main"."ledger"')
  })
})
