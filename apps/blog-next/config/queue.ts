import { defineQueueConfig } from '@holo-js/queue'
export default defineQueueConfig({
  default: 'database',
  failed: {
    driver: 'database',
    connection: 'main',
    table: 'failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'main',
      table: 'jobs',
      queue: 'default',
      retryAfter: 90,
      sleep: 1,
    },
  },
})
