import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('admins', (table) => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.string('password').nullable()
      table.string('avatar').nullable()
      table.timestamp('email_verified_at').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('admins')
  },
})
