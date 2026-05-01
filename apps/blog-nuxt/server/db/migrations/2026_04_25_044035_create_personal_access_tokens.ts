import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('personal_access_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('name')
      table.string('token_hash').unique()
      table.json('abilities').default([])
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['user_id'])
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('personal_access_tokens')
  },
})
