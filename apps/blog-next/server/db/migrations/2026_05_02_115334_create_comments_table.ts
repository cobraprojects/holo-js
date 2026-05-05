import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('comments', (table) => {
      table.id()
      table.integer('post_id')
      table.integer('user_id')
      table.text('body')
      table.string('status').default('pending')
      table.timestamps()
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('comments')
  },
})
