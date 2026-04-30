import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('notifications', (table) => {
      table.string('id').primaryKey()
      table.string('type').nullable()
      table.string('notifiable_type')
      table.string('notifiable_id')
      table.json('data').default({})
      table.timestamp('read_at').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.index(['notifiable_type', 'notifiable_id'])
      table.index(['read_at'])
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('notifications')
  },
})
