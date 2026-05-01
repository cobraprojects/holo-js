# Failed Jobs

Holo-JS supports a shared failed-job store for async drivers. By default, `config/queue.ts` uses a
database-backed failed-job table named `failed_jobs`.

## List failed jobs

```bash
npx holo queue:failed
```

Use this to inspect failed jobs and copy the failed-job record ID for retry or deletion.

## Retry failed jobs

Retry one failed job:

```bash
npx holo queue:retry 01JZ123456789ABCDEFGHJKMNP
```

Retry every stored failed job:

```bash
npx holo queue:retry all
```

## Delete one failed job record

```bash
npx holo queue:forget 01JZ123456789ABCDEFGHJKMNP
```

This removes the failed-job record without retrying it.

## Flush the failed-job store

```bash
npx holo queue:flush
```

Use this only when you intentionally want to clear every stored failed job record.

## Failed-job storage config

The default scaffold keeps failed jobs in the database:

```ts
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
})
```

Disable failed-job persistence when you do not want to keep failed async jobs:

```ts
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  failed: false,
})
```

## When failed jobs are stored

- `sync` jobs run inline and do not go through the async failed-job store.
- `redis` workers can persist failed jobs.
- `database` workers can persist failed jobs.

If you want failed-job commands to work, keep the failed-job store enabled and generate the failed jobs
table.

## Continue

- [Database Tables](/queue/database)
- [Workers](/queue/workers)
