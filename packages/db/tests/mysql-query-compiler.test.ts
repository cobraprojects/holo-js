import { describe, expect, it } from 'vitest'
import { MySQLQueryCompiler } from '../src/query/MySQLQueryCompiler'
import type { UpsertQueryPlan } from '../src/query/ast'

class ExposedMySQLQueryCompiler extends MySQLQueryCompiler {
  public compileUpsertSuffixForTest(plan: UpsertQueryPlan, insertColumns: readonly string[]): string {
    return this.compileUpsertSuffix(plan, insertColumns)
  }
}

describe('mysql query compiler module coverage', () => {
  it('executes mysql upsert suffix fallback and explicit update paths directly', () => {
    const compiler = new ExposedMySQLQueryCompiler(identifier => `\`${identifier}\``, () => '?')

    expect(
      compiler.compileUpsertSuffixForTest(
        {
          kind: 'upsert',
          source: { kind: 'table', tableName: 'users' },
          values: [{ id: 1, email: 'm@example.com', name: 'Mohamed' }],
          uniqueBy: ['email'],
          updateColumns: [],
        },
        ['id', 'email', 'name'],
      ),
    ).toBe(' ON DUPLICATE KEY UPDATE `email` = VALUES(`email`)')

    expect(
      compiler.compileUpsertSuffixForTest(
        {
          kind: 'upsert',
          source: { kind: 'table', tableName: 'users' },
          values: [{ id: 1, email: 'm@example.com', name: 'Mohamed' }],
          uniqueBy: ['email'],
          updateColumns: ['name'],
        },
        ['id', 'email', 'name'],
      ),
    ).toBe(' ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)')

    expect(
      compiler.compileUpsertSuffixForTest(
        {
          kind: 'upsert',
          source: { kind: 'table', tableName: 'users' },
          values: [{ id: 1, email: 'm@example.com', name: 'Mohamed' }],
          uniqueBy: [],
          updateColumns: [],
        },
        ['id', 'email', 'name'],
      ),
    ).toBe(' ON DUPLICATE KEY UPDATE `id` = VALUES(`id`)')
  })
})
