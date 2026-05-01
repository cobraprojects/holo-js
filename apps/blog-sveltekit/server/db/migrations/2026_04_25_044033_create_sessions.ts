import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store').default('database')
      table.json('data').default({})
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.string('remember_token_hash').nullable()
      table.index(['expires_at'])
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('sessions')
  },
})
