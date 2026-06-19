import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('email_verification_tokens', (table) => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('user_id')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['user_id'])
      table.index(['email'])
    })
  },
  async down({ schema }) {
    await schema.dropTable('email_verification_tokens')
  },
})
