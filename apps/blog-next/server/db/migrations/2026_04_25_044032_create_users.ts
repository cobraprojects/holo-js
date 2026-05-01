import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.string('password').nullable()
      table.string('avatar').nullable()
      table.timestamp('email_verified_at').nullable()
      table.timestamps()
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('users')
  },
})
