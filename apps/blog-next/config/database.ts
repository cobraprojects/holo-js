import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'
export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: env('DB_DRIVER', 'sqlite'),
      url: env('DB_URL', './storage/database.sqlite'),
      security: { allowUnsafeRawSql: true },
    },
    sqlite: {
      driver: 'sqlite',
      url: env('DB_SQLITE_URL', './storage/database.sqlite'),
    },
    postgres: {
      driver: 'postgres',
      url: env('DB_POSTGRES_URL', 'postgresql://postgres@127.0.0.1:5432/holo_blog_next'),
    },
    mysql: {
      driver: 'mysql',
      url: env('DB_MYSQL_URL', 'mysql://root@127.0.0.1:3306/holo_blog_next'),
    },
  },
})
