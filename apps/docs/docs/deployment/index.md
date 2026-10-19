# Deploying Holo Apps

A Holo app deploys like any Next.js, Nuxt, or SvelteKit app, with two additions: you run database migrations as a deploy step, and you may need long-running worker processes for queues and broadcasting. This page walks through a typical deploy.

## The short version

```bash
npm ci
npx holo migrate
npm run build
npm run start
```

Plus, if you use them:

```bash
npx holo queue:work --connection redis
npx holo broadcast:work
```

The scaffolded `build` and `start` scripts run `holo build` and `holo start`.

## Pick a host by what your app runs

What you need depends on whether anything has to keep running after a request ends.

| Your app uses | You need | Hosts that fit |
| --- | --- | --- |
| Pages, API routes, database, auth, forms, storage, `sync` queue | A web server only | Any host your framework supports, including Vercel and Cloudflare when the framework supports them |
| `redis` or `database` queues, queued mail or notifications, queued listeners, media conversions on a queue | Web server + queue worker | Web app anywhere, plus a VPS, container service, or PaaS that runs long-lived processes |
| Self-hosted broadcasting (`holo` driver) or [realtime queries](/realtime/) | Web server + broadcast worker | Same as above |

A common setup is to put the web app on a serverless platform and run workers on a small server or container, all with the same environment variables. Serverless platforms can't run workers on their own.

## Build

```bash
npm run build
```

`holo build` refreshes Holo's generated files (model and job registries, generated schema types) and then runs your framework's build. Extra arguments are passed to the framework.

::: warning
`holo build` connects to your database to read which migrations have run, and uses that to generate schema information. The build environment needs the same database settings as production, and you should run migrations before building.
:::

## Start the server

```bash
npm run start
```

`holo start` loads your `.env` files and starts the framework's production server with Holo ready before your code runs:

| Framework | What `holo start` runs |
| --- | --- |
| Next.js | `next start` |
| Nuxt | `node .output/server/index.mjs` |
| SvelteKit | `node build/index.js` (adapter-node) |

Use `holo start` in your process manager (systemd, PM2, Docker, and so on) instead of calling the framework's server directly. Pass server options after it:

```bash
npx holo start --hostname 0.0.0.0 --port 3000
```

::: warning
New Next.js apps trust forwarded headers from any connection with `trustedProxies: '*'`. Make the app reachable only through your proxy, for example by listening on `127.0.0.1` behind nginx. See [Trusted proxies in Next.js](/basics/security/cors-and-proxies#next-js).
:::

If you don't pass `--port`, Holo uses the `PORT` environment variable.

## Run migrations

Run migrations as an explicit deploy step, before you build and before new code serves traffic:

```bash
npx holo migrate
```

Holo never migrates on startup. A typical deploy:

1. Install dependencies.
2. Run tests.
3. Run `npx holo migrate` against the production database.
4. Build with `npm run build`.
5. Cache config with `npx holo config:cache` (optional).
6. Start or restart the web server and workers.

If several replicas run step 3 at once, use `npx holo migrate --isolated`. One replica applies the migrations and the others skip them without failing the deploy. See [Isolating migration runs](/database/migrations#isolating-migration-runs).

To undo the last deploy's migrations, run `npx holo migrate:rollback`. In production it asks you to confirm, so pass `--force` in a script. See [Migrations](/database/migrations).

## Run workers

Run each worker as its own supervised process, next to the web server. Don't start workers from inside a web request.

### Queue workers

```bash
npx holo queue:work --connection redis --queue default,emails
```

Run one process per queue group you need, and add more processes to handle more jobs. After each deploy, tell running workers to finish their current job and exit, so your process manager starts them on the new code:

```bash
npx holo queue:restart
```

See [Running Workers](/queue/workers) and the [CLI reference](/reference/cli#queue-work) for every flag.

### Broadcast worker

```bash
npx holo broadcast:work
```

It listens on `worker.host` and `worker.port` from `config/broadcast.ts` (default `0.0.0.0:8080`). Put it behind your reverse proxy with WebSocket support. To run more than one, turn on Redis scaling. See [Scaling in Production](/broadcasting/production).

## Cache config

```bash
APP_ENV=production npx holo config:cache
```

This compiles `config/*.ts` and your env values into `.holo-js/generated/config-cache.json`, which Holo reads in production instead of loading each config file. Run it on every deploy, after your environment variables are in place. Remove it with `npx holo config:clear`.

## Environment variables

Set production values through your host's environment settings or a `.env.production` file on the server. At minimum:

```ini
APP_ENV=production
APP_DEBUG=false
APP_KEY=your-generated-key
APP_URL=https://blog.example.com
```

Generate `APP_KEY` once with `npx holo key:generate` and keep it the same across deploys. When `APP_ENV` isn't set, Holo runs as `production`. Don't copy your development `.env` to the server: its `APP_ENV=development` would win over that default. See [Environment Variables](/reference/environment).

## Next steps

- [Production Checklist](/deployment/checklist)
- [Running Workers](/queue/workers)
- [Scaling Broadcasting](/broadcasting/production)
- [CLI Commands](/reference/cli)
