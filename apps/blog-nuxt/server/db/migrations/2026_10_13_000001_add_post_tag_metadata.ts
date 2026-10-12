import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.table('post_tags', table => {
      table.boolean('is_primary').default(false)
    })
  },
  async down({ schema }) {
    await schema.table('post_tags', table => {
      table.dropColumn('is_primary')
    })
  },
})
