import { defineCacheConfig, env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'database',
  prefix: env('CACHE_PREFIX', ''),
  drivers: {
    file: {
      driver: 'file',
      path: './storage/framework/cache/data',
    },
    memory: {
      driver: 'memory',
      maxEntries: 1000,
    },
    database: {
      driver: 'database',
      connection: 'main',
      table: 'cache',
      lockTable: 'cache_locks',
    },
  },
})
