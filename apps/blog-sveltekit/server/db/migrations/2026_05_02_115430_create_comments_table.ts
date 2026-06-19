import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('comments', (table) => {
      table.id()
      table.integer('post_id')
      table.index(['post_id'])
      table.integer('user_id')
      table.index(['user_id'])
      table.text('body')
      table.string('status').default('pending')
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('comments')
  },
})
