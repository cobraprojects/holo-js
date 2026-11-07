import { expect, it, onTestFinished } from 'vitest'
import { DB, resetDB } from '../src'
import { aliasTableSource, requalifyTableSource } from '../src/query/TableQueryBuilder'
import { openDatabase } from './support/database'

it('leaves join conditions on unqualified columns alone when a later join is named like the related table', async () => {
  await openDatabase('sqlite')
  onTestFinished(() => resetDB())
  const nested = DB.table('quotas').join('limits', 'users', '=', 'limits.capacity').join('members as user', 'user.id', '=', 'quotas.member_id')
  const related = aliasTableSource(DB.table('user').whereExists(nested), 'holo_reserved_0')

  const requalified = requalifyTableSource(related)

  const exists = requalified.getPlan().predicates[0]
  expect(exists?.kind).toBe('exists')
  expect(exists?.kind === 'exists' ? exists.subquery.joins.map(join => [join.leftColumn, join.rightColumn]) : []).toEqual([
    ['users', 'limits.capacity'],
    ['user.id', 'quotas.member_id'],
  ])
})
