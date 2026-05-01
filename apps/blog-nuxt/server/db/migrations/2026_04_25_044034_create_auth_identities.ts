import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('auth_identities', (table) => {
      table.id()
      table.string('user_id')
      table.string('guard').default('web')
      table.string('auth_provider').default('users')
      table.string('provider')
      table.string('provider_user_id')
      table.string('email').nullable()
      table.boolean('email_verified').default(false)
      table.json('profile').default({})
      table.json('tokens').default({})
      table.timestamps()
      table.index(['user_id'])
      table.unique(['provider', 'provider_user_id'], 'auth_identities_provider_user_unique')
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('auth_identities')
  },
})
