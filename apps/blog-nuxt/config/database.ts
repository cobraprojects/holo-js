import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'
export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DB_URL', './storage/database.sqlite'),
    },
  },
})
