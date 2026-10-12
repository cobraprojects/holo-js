import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('auth_multi_factor_credentials', (table) => {
      table.id()
      table.string('provider')
      table.string('user_id')
      table.string('encrypted_secret')
      table.json('recovery_code_hashes')
      table.integer('last_used_counter').nullable()
      table.timestamp('enabled_at')
      table.timestamps()
      table.unique(['provider', 'user_id'], 'auth_mfa_provider_user_unique')
    })
  },
  async down({ schema }) {
    await schema.dropTable('auth_multi_factor_credentials')
  },
})
