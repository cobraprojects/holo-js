import { describe, expect, it } from 'vitest'
import { SecurityError, column } from '../src'
import {
  appendAggregateSelection,
  appendRawSelection,
  appendSelections,
  appendSubquerySelection,
  createDeleteQueryPlan,
  createInsertQueryPlan,
  createSelectQueryPlan,
  createTableSource,
  createUpdateQueryPlan,
  createUpsertQueryPlan,
  replaceOrderBy,
  withDistinct,
  withGroupBy,
  withHaving,
  withJoin,
  withLimit,
  withLockMode,
  withOffset,
  withOrderBy,
  withPredicate,
  withSelections,
  withSource,
  withUnion,
  withoutPredicates } from '../src/query/ast'
import { validateQueryPlan } from '../src/query/validator'
import { defineTable } from './support/internal'

describe('query ast and planner normalization', () => {
  it('creates immutable canonical plan shapes for select and mutation helpers', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string().notNull(),
      active: column.boolean() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().notNull() })

    const aliasedSource = createTableSource('users as u')
    expect(aliasedSource).toEqual({
      kind: 'table',
      tableName: 'users',
      alias: 'u' })

    const postsSubquery = withSelections(createSelectQueryPlan(createTableSource(posts)), ['userId'])
    let plan = createSelectQueryPlan(createTableSource(users))
    plan = withDistinct(plan)
    plan = withSelections(plan, ['id', 'name as displayName'])
    plan = appendSelections(plan, ['active'])
    plan = appendAggregateSelection(plan, { kind: 'aggregate', aggregate: 'count', column: '*', alias: 'postsCount' })
    plan = appendRawSelection(plan, { kind: 'raw', sql: 'upper(name)', bindings: [] })
    plan = appendSubquerySelection(plan, postsSubquery, 'postOwnerId')
    plan = withPredicate(plan, { kind: 'comparison', column: 'id', operator: '>', value: 0 })
    plan = withJoin(plan, {
      type: 'inner',
      table: 'posts',
      leftColumn: 'users.id',
      operator: '=',
      rightColumn: 'posts.userId' })
    plan = withUnion(plan, { all: false, query: withSelections(createSelectQueryPlan(createTableSource(users)), ['id']) })
    plan = withGroupBy(plan, ['id', 'name'])
    plan = withHaving(plan, { expression: 'count(*)', operator: '>', value: 0 })
    plan = withOrderBy(plan, { kind: 'column', column: 'id', direction: 'asc' })
    plan = replaceOrderBy(plan, [{ kind: 'random' }])
    plan = withLockMode(plan, 'update')
    plan = withLimit(plan, 10)
    plan = withOffset(plan, 5)

    const withoutComparison = withoutPredicates(plan, predicate => predicate.kind === 'comparison')
    expect(withoutComparison.predicates).toEqual([])

    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.selections)).toBe(true)
    expect(Object.isFrozen(plan.joins)).toBe(true)
    expect(Object.isFrozen(plan.unions)).toBe(true)
    expect(plan.distinct).toBe(true)
    expect(plan.selections).toHaveLength(6)
    expect(plan.groupBy).toEqual(['id', 'name'])
    expect(plan.having).toEqual([{ expression: 'count(*)', operator: '>', value: 0 }])
    expect(plan.orderBy).toEqual([{ kind: 'random' }])
    expect(plan.lockMode).toBe('update')
    expect(plan.limit).toBe(10)
    expect(plan.offset).toBe(5)

    const insertPlan = createInsertQueryPlan(createTableSource(users), [{ name: 'A', active: true }], { ignoreConflicts: true })
    const upsertPlan = createUpsertQueryPlan(createTableSource(users), [{ id: 1, name: 'A', active: true }], ['id'], ['name'])
    const updatePlan = createUpdateQueryPlan(createTableSource(users), [{ kind: 'comparison', column: 'id', operator: '=', value: 1 }], {
      name: 'B' })
    const deletePlan = createDeleteQueryPlan(createTableSource(users), [{ kind: 'comparison', column: 'id', operator: '=', value: 1 }])

    expect(insertPlan.kind).toBe('insert')
    expect(insertPlan.ignoreConflicts).toBe(true)
    expect(upsertPlan.kind).toBe('upsert')
    expect(updatePlan.kind).toBe('update')
    expect(deletePlan.kind).toBe('delete')
    expect(Object.isFrozen(insertPlan.values)).toBe(true)
    expect(Object.isFrozen(upsertPlan.uniqueBy)).toBe(true)
    expect(Object.isFrozen(updatePlan.values)).toBe(true)
    expect(Object.isFrozen(deletePlan.predicates)).toBe(true)
  })

  it('validates handcrafted valid plans across the remaining shared AST families', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string().notNull(),
      settings: column.json<{ profile: { name: string } }>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable(),
      createdAt: column.timestamp().nullable() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().notNull(),
      title: column.string().notNull() })

    const relatedPosts = withSelections(createSelectQueryPlan(createTableSource(posts)), ['userId'])
    let plan = createSelectQueryPlan(createTableSource(users))
    plan = withSource(plan, createTableSource(users))
    plan = withSelections(plan, ['id', 'name as displayName'])
    plan = appendAggregateSelection(plan, { kind: 'aggregate', aggregate: 'count', column: '*', alias: 'postCount' })
    plan = appendRawSelection(plan, { kind: 'raw', sql: 'upper(name)', bindings: [] })
    plan = appendSubquerySelection(plan, relatedPosts, 'relatedUserId')
    plan = withJoin(plan, {
      type: 'inner',
      table: 'posts',
      leftColumn: 'users.id',
      operator: '=',
      rightColumn: 'posts.userId' })
    plan = withPredicate(plan, { kind: 'comparison', column: 'id', operator: '>', value: 0 })
    plan = withPredicate(plan, { kind: 'column', column: 'id', operator: '>=', compareTo: 'id' })
    plan = withPredicate(plan, { kind: 'null', column: 'settings', negated: false })
    plan = withPredicate(plan, { kind: 'date', column: 'createdAt', part: 'year', operator: '=', value: '2025' })
    plan = withPredicate(plan, {
      kind: 'json',
      column: 'settings',
      path: ['profile', 'name'],
      jsonMode: 'value',
      operator: '=',
      value: 'Mohamed' })
    plan = withPredicate(plan, {
      kind: 'vector',
      column: 'embedding',
      vector: [0.1, 0.2, 0.3],
      minSimilarity: 0.5 })
    plan = withPredicate(plan, {
      kind: 'group',
      predicates: [{ kind: 'comparison', column: 'name', operator: 'like', value: 'M%' }] })
    plan = withPredicate(plan, {
      kind: 'exists',
      subquery: relatedPosts })
    plan = withPredicate(plan, {
      kind: 'subquery',
      column: 'id',
      operator: 'in',
      subquery: relatedPosts })
    plan = withPredicate(plan, {
      kind: 'raw',
      sql: 'name <> ?',
      bindings: ['Blocked'] })
    plan = withGroupBy(plan, ['id', 'name'])
    plan = withHaving(plan, { expression: 'count(*)', operator: '>', value: 0 })
    plan = withOrderBy(plan, { kind: 'column', column: 'id', direction: 'asc' })
    plan = withUnion(plan, { all: true, query: withSelections(createSelectQueryPlan(createTableSource(users)), ['id']) })
    plan = withLimit(plan, 25)
    plan = withOffset(plan, 5)

    expect(() => validateQueryPlan(plan)).not.toThrow()
  })

  it('rejects malformed handcrafted plans across remaining planner paths', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string().notNull(),
      settings: column.json<Record<string, unknown>>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().notNull() })

    const subquery = withSelections(createSelectQueryPlan(createTableSource(posts)), ['userId'])

    expect(() => validateQueryPlan(withPredicate(
      createSelectQueryPlan(createTableSource(users)),
      { kind: 'group', predicates: [] },
    ))).toThrow(SecurityError)

    expect(() => validateQueryPlan(withJoin(
      createSelectQueryPlan(createTableSource(users)),
      { type: 'inner', subquery },
    ))).toThrow(SecurityError)

    expect(() => validateQueryPlan(appendRawSelection(
      createSelectQueryPlan(createTableSource(users)),
      { kind: 'raw', sql: 'upper(name)', bindings: ['extra'] },
    ))).toThrow(SecurityError)

    expect(() => validateQueryPlan(withPredicate(
      createSelectQueryPlan(createTableSource(users)),
      { kind: 'vector', column: 'name', vector: [1, 2, 3], minSimilarity: 0.5 },
    ))).toThrow(SecurityError)
  })
})
