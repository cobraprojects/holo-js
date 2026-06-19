import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('failed_jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job_id')
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.text('exception')
      table.bigInteger('failed_at')
      table.index(['job_id'], 'failed_jobs_job_id_index')
      table.index(['failed_at'], 'failed_jobs_failed_at_index')
    })
  },
  async down({ schema }) {
    await schema.dropTable('failed_jobs')
  },
})
