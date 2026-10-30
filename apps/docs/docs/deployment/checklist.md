# Production Checklist

Go through this list before your first production deploy, and again when you add a new Holo feature. Each item links to the page with details.

## App and environment

- [ ] `APP_ENV` is `production` or unset on the server, and the server's `.env` doesn't set `APP_ENV=development`. Holo then loads `.env.production`. See [Environment Variables](/reference/environment#env-files-and-loading-order).
- [ ] `APP_KEY` is set to a value from `npx holo key:generate`, and stays the same across deploys. Changing it signs every user out, and breaks CSRF tokens, signed storage URLs, and encrypted social login tokens.
- [ ] `APP_DEBUG=false`, so errors don't show internal details.
- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `.env` files with secrets are not committed. Only `.env.example` is.
- [ ] Secrets are only read in server code, never passed to client components or public runtime config.

## Database

- [ ] `DB_*` variables point at the production database.
- [ ] `npx holo migrate` runs as a deploy step, before `holo build` and before new code serves traffic. See [Deploying](/deployment/#run-migrations).
- [ ] You never run `migrate:fresh` or `seed` against production. (`migrate:fresh`, `migrate:rollback`, and `seed` ask for confirmation in production, and stop without a terminal unless you pass `--force`.)
- [ ] Postgres pool settings (`DB_POOL_MAX` and friends) fit your database's connection limit across all web and worker processes.

## Build and start

- [ ] The build runs `npm run build` (`holo build`) with database access.
- [ ] The server starts with `npm run start` (`holo start`), not the framework's server command.
- [ ] `APP_ENV=production npx holo config:cache` runs on every deploy if you use the config cache. See [config:cache](/reference/cli#config-cache).

## Queues

Skip this if `QUEUE_CONNECTION=sync`.

- [ ] At least one `holo queue:work` process runs under a process manager that restarts it.
- [ ] Every queue your jobs use (for example `default`, `emails`, `media`) is covered by a worker's `--queue` list.
- [ ] `npx holo queue:restart` runs after each deploy.
- [ ] The failed jobs table exists (`npx holo queue:failed-table`), and you check `npx holo queue:failed`. See [Failed Jobs](/queue/failed-jobs).

## Scheduler

Skip this if your app has no `server/schedule.ts` (or `.mts`, `.js`, or `.mjs`).

- [ ] One cron entry runs `npx holo schedule:run` every minute, or `holo schedule:work` runs under a process manager that restarts it.
- [ ] Tasks that use `withoutOverlapping()` or `onOneServer()` use a cache store every scheduler process shares (`redis` or `database` across servers). See [Task Scheduling](/scheduling/).

## Broadcasting

Skip this if you don't use the `holo` broadcast driver.

- [ ] `holo broadcast:work` runs as a supervised process behind a proxy with WebSocket support.
- [ ] `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, and `BROADCAST_APP_SECRET` are set to values from `holo new` or `holo install broadcast`, not copied from a development `.env`.
- [ ] `BROADCAST_SCHEME=https`, and `worker.allowedOrigins` lists your app's URL.
- [ ] More than one worker? Redis scaling is turned on. See [Scaling in Production](/broadcasting/production).

## Cache and sessions

- [ ] The cache driver works with more than one server. `file` and `memory` are per server; use `redis` or `database` when you run several. See [Cache Drivers](/cache/drivers).
- [ ] The session store is shared the same way (`SESSION_DRIVER=redis` or `database` for several servers). See [Sessions](/basics/session).
- [ ] `SESSION_SECURE=true`, so session cookies are only sent over HTTPS.

## Storage

- [ ] On servers with temporary disks (containers, serverless), uploads go to an S3 disk, not `local` or `public`. See [Amazon S3](/storage/s3).
- [ ] S3 credentials are set through `STORAGE_DISKS_S3_*` variables.
- [ ] If you use local disks, `storage/` is on a persistent volume and backed up.

## Security

- [ ] CSRF protection is on for apps with cookie-based forms. See [CSRF Protection](/basics/security/csrf).
- [ ] Rate limits aren't on the `memory` driver when you run more than one process. Use `file` for several processes on one server and `redis` for several servers. See [Rate Limiting](/basics/security/rate-limiting).
- [ ] `config/cors.ts` lists only your real frontend origins.
- [ ] `TRUSTED_PROXIES` (or `trustedProxies` in `config/security.ts`) lists only proxies that every request passes through. With `*`, including in Next.js apps, the app is reachable only through the proxy. See [Trusted proxies](/basics/security/cors-and-proxies#trusted-proxies).

## Mail

- [ ] `MAIL_MAILER` is a real mailer such as `smtp`, not `preview`, `log`, or `fake`.
- [ ] `MAIL_FROM_ADDRESS` uses a domain you've set up for sending.

## Logging

- [ ] Database query logging (`logging` and `security.debugSqlInLogs` in `config/database.ts`) is off unless you're debugging.
- [ ] Your host collects stdout and stderr from the web server and every worker.

## Related

- [Deploying Holo Apps](/deployment/)
- [Environment Variables](/reference/environment)
- [Configuration Files](/reference/config)
