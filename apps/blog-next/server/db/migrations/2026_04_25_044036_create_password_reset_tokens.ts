import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('password_reset_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['email'])
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('password_reset_tokens')
  },
})
