import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.integer('attempts').default(0)
      table.integer('max_attempts').default(1)
      table.bigInteger('available_at')
      table.bigInteger('reserved_at').nullable()
      table.string('reservation_id').nullable()
      table.bigInteger('created_at')
      table.index(['queue', 'available_at'], 'jobs_queue_available_at_index')
      table.index(['queue', 'reserved_at'], 'jobs_queue_reserved_at_index')
      table.index(['reservation_id'], 'jobs_reservation_id_index')
    })
  },
  async down({ schema }) {
    await schema.dropTable('jobs')
  },
})
