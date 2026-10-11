import authorization, { definePolicy, authorizationInternals } from '@holo-js/authorization'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, expect, it } from 'vitest'
import {
  clearGeneratedTables,
  column,
  configureDB,
  createConnectionManager,
  createDialect,
  defineGeneratedTable,
  defineModel,
  registerGeneratedTables,
  resetDB,
  resetGlobalModelRegistry,
} from '../src'

afterEach(() => {
  resetDB()
  clearGeneratedTables()
  resetGlobalModelRegistry()
  authorizationInternals.resetAuthorizationRuntimeState()
})

it('authorizes records when the policy registers before generated schema hydration', async () => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  const Comment = defineModel('policy_comments', { name: 'PolicyComment', timestamps: false })
  definePolicy('policy-comments', Comment, {
    class: { viewAny: () => true },
    record: { view: () => true },
  })
  registerGeneratedTables({ comments: defineGeneratedTable('policy_comments', { id: column.id() }) })

  try {
    const actor = authorization.forUser({ id: 1 })
    await expect(actor.can('viewAny', Comment)).resolves.toBe(true)
    await expect(actor.can('view', Comment.make())).resolves.toBe(true)
  } finally {
    await adapter.disconnect()
  }
})
