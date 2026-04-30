import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('posts', (table) => {
      table.id()
      table.integer('user_id')
      table.integer('category_id').nullable()
      table.string('title')
      table.string('slug').unique()
      table.string('status').default('draft')
      table.text('excerpt').nullable()
      table.text('body')
      table.timestamp('published_at').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('posts')
  },
})
