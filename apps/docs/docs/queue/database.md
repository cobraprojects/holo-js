# Queue Database Tables

Queue tables are app-owned migrations. Holo-JS does not hide them inside a package.

## Generate the jobs table

Use this when your queue connection uses the `database` driver:

```bash
npx holo queue:table
```

That creates a normal migration file under `server/db/migrations`.

## Generate the failed jobs table

Use this when your queue config keeps failed jobs in the database:

```bash
npx holo queue:failed-table
```

This is the default failed-job setup that new queue scaffolds write.

## Run the migrations

After generating the files, migrate normally:

```bash
npx holo migrate
```

Or for a fresh local rebuild:

```bash
npx holo migrate:fresh --seed --force
```

## Database queue config

The `database` queue connection points at an existing Holo-JS database connection by name:

```ts
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  default: 'database',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
      retryAfter: 90,
      sleep: 1,
    },
  },
})
```

The queue layer does not duplicate full DB credentials here. It reuses the named DB connection from
`config/database.ts`.

## Typical setup flow

```bash
npx holo install queue --driver database
npx holo queue:table
npx holo queue:failed-table
npx holo migrate
npx holo queue:work --connection database
```

## Continue

- [Failed Jobs](/queue/failed-jobs)
- [Workers](/queue/workers)
