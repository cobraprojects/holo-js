import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('tags', (table) => {
      table.id()
      table.string('name')
      table.string('slug').unique()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('tags')
  },
})
