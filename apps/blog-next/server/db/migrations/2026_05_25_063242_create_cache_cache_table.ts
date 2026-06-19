import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('cache', (table) => {
      table.string('key').primaryKey()
      table.text('payload')
      table.bigInteger('expires_at').nullable()
      table.index(['expires_at'], 'cache_expires_at_index')
    })
    await schema.createTable('cache_locks', (table) => {
      table.string('name').primaryKey()
      table.string('owner')
      table.bigInteger('expires_at')
      table.index(['expires_at'], 'cache_locks_expires_at_index')
    })
  },
  async down({ schema }) {
    await schema.dropTable('cache_locks')
    await schema.dropTable('cache')
  },
})
