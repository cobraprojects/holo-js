import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('categories', (table) => {
      table.id()
      table.string('name')
      table.string('slug').unique()
      table.text('description').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('categories')
  },
})
