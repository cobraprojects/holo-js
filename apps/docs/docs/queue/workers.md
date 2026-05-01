# Queue Workers

Workers are only needed for async queue drivers such as `redis` and `database`. The `sync` driver runs
jobs inline and does not need a worker process.

## `queue:work`

Run the queue worker:

```bash
npx holo queue:work --connection redis
```

Filter one or more queue names:

```bash
npx holo queue:work --connection redis --queue emails
npx holo queue:work --connection redis --queue emails,media
```

Useful flags:

- `--once`
- `--stop-when-empty`
- `--sleep N`
- `--tries N`
- `--timeout N`
- `--max-jobs N`
- `--max-time N`

Example:

```bash
npx holo queue:work \
  --connection database \
  --queue default,media \
  --sleep 1 \
  --tries 3 \
  --timeout 120 \
  --max-jobs 500 \
  --max-time 3600
```

## `queue:listen`

`queue:listen` is a watch-mode worker for development. It watches queue-related project files, rebuilds
discovery as needed, and restarts the worker when relevant files change.

```bash
npx holo queue:listen --connection redis --queue media
```

This is the right command when you want a queue worker running while editing job files in local
development.

## `queue:restart`

Signal long-lived workers to restart after the current job:

```bash
npx holo queue:restart
```

Use this after deploying new code when your process manager keeps queue workers alive.

## `queue:clear`

Clear pending jobs from a connection:

```bash
npx holo queue:clear --connection redis
npx holo queue:clear --connection redis --queue emails
```

This removes pending work from the selected queue names. It is not a failed-job command.

## Worker strategy

- Use `queue:work` in production and supervised environments.
- Use `queue:listen` in development.
- Use `queue:restart` during deploys for long-lived workers.
- Use `queue:clear` only when you intentionally want to drop pending work.

## Queue-specific workers

Running dedicated workers for separate queues is often cleaner than one large worker pool:

```bash
npx holo queue:work --connection redis --queue emails
npx holo queue:work --connection redis --queue media
```

That keeps email and media workloads isolated even when they share one Redis connection.

## Continue

- [Queue Getting Started](/queue/)
- [Failed Jobs](/queue/failed-jobs)
