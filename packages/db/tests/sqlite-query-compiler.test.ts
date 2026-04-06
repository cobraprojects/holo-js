import { describe, expect, it } from 'vitest'
import { SQLiteQueryCompiler } from '../src/query/SQLiteQueryCompiler.impl'
import type { InsertQueryPlan, QueryDatePredicate, QueryJsonPredicate, QueryJsonUpdateOperation } from '../src/query/ast'

class ExposedSQLiteQueryCompiler extends SQLiteQueryCompiler {
  public compileJsonPredicateForTest(predicate: QueryJsonPredicate, bindings: unknown[]): string {
    return this.compileJsonPredicate(predicate, bindings)
  }

  public compileJsonUpdateOperationsForTest(
    column: string,
    operations: readonly QueryJsonUpdateOperation[],
    bindings: unknown[],
  ): string {
    return this.compileJsonUpdateOperations(column, operations, bindings)
  }

  public compileDatePredicateForTest(predicate: QueryDatePredicate, placeholder: string): string {
    return this.compileDatePredicate(predicate, placeholder)
  }

  public compileInsertPrefixForTest(plan: InsertQueryPlan): string {
    return this.compileInsertPrefix(plan)
  }
}

describe('sqlite query compiler module coverage', () => {
  it('executes the sqlite-specific compiler overrides directly', () => {
    const compiler = new ExposedSQLiteQueryCompiler(identifier => `"${identifier}"`, () => '?')

    const jsonValueBindings: unknown[] = []
    expect(
      compiler.compileJsonPredicateForTest(
        {
          kind: 'json',
          column: 'settings',
          path: ['profile', 'region'],
          jsonMode: 'value',
          operator: '=',
          value: 'mena',
        },
        jsonValueBindings,
      ),
    ).toBe(`json_extract("settings", '$.profile.region') = ?`)
    expect(jsonValueBindings).toEqual(['mena'])

    const updateBindings: unknown[] = []
    expect(
      compiler.compileJsonUpdateOperationsForTest(
        'settings',
        [
          { kind: 'json-set', path: ['profile', 'region'], value: 'mena' },
          { kind: 'json-set', path: ['flags', 'beta'], value: true },
        ],
        updateBindings,
      ),
    ).toBe(`json_set(json_set(COALESCE("settings", json('{}')), '$.profile.region', json(?)), '$.flags.beta', json(?))`)
    expect(updateBindings).toEqual([JSON.stringify('mena'), JSON.stringify(true)])

    expect(
      compiler.compileDatePredicateForTest(
        { kind: 'date', column: 'created_at', part: 'year', operator: '=', value: '2026' },
        '?',
      ),
    ).toBe(`strftime('%Y', "created_at") = ?`)

    expect(
      compiler.compileInsertPrefixForTest({
        kind: 'insert',
        source: { kind: 'table', tableName: 'users' },
        values: [{}],
        ignoreConflicts: false,
      }),
    ).toBe(
      'INSERT INTO',
    )
    expect(
      compiler.compileInsertPrefixForTest({
        kind: 'insert',
        source: { kind: 'table', tableName: 'users' },
        values: [{}],
        ignoreConflicts: true,
      }),
    ).toBe(
      'INSERT OR IGNORE INTO',
    )
  })
})
