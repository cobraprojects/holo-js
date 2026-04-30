import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('post_tags', (table) => {
      table.integer('post_id')
      table.integer('tag_id')
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('post_tags')
  },
})
