# Deployment

Deployment should be configuration-driven and predictable. Holo-JS stays portable by separating framework
support from hosting support.

The goal is simple: configure backend infrastructure once, keep application code stable, and deploy
anywhere the selected framework can run.

## Baseline model

Think about a Holo-JS deployment as one web runtime plus zero or more worker runtimes. The web runtime
handles HTTP request work. Worker runtimes handle work that must keep running after a request ends.

This model keeps Holo-JS portable across:

- VPS and Docker
- managed servers and container platforms
- Vercel
- Cloudflare
- other framework-supported hosts

Database, storage, queue, and broadcast choices stay independent in this model. A project can change one
without forcing a rewrite of the others.

## Choose a host by runtime shape

Deployment support depends on what the application needs to keep running after an HTTP request ends:

| Runtime shape | Examples | Suitable hosting |
| --- | --- | --- |
| Web runtime only | static pages, server-rendered pages, API routes, auth, database access, storage access, forms, validation | Vercel, Cloudflare, or another framework host when the selected framework supports that provider |
| Web runtime plus workers | async queues, queued mail, queued notifications, queued events, queued media conversions, self-hosted broadcast, realtime browser updates | web app on any supported framework host, plus a managed server, container service, VPS, or worker-capable PaaS for the long-running processes |

Serverless and edge request platforms are still valid for the web app in that architecture, but they should
not be the only runtime when the application also needs Holo-managed workers. A common split is to deploy the
web app to Vercel or Cloudflare and run queue or broadcast workers on a managed server or container service
with the same environment configuration.

When the app has no worker runtime, a request-only deployment on Vercel, Cloudflare, or the selected
framework's hosted platform is usually enough.

## Build artifacts deliberately

For deployable artifacts, keep these steps explicit:

```bash
holo config:cache
npm run build
```

`npm run build` maps to `holo build` in scaffolded apps, and `holo build` refreshes discovery output before
starting the framework build. `holo config:cache` is optional but useful when you want production to read
cached config instead of resolving live files on startup.

## Start production through Holo

Use the Holo production start command for self-hosted Node deployments:

```bash
npm run start
```

Scaffolded apps map that script to `holo start`. The command preloads Holo runtime artifacts before
starting the selected framework:

- Next.js runs `next start`
- Nuxt runs `node .output/server/index.mjs`
- SvelteKit runs `node build/index.js`

Use `holo start` in process managers such as PM2, systemd, Docker, Forge, or container platforms instead of
calling the framework production entrypoint directly. That keeps database, auth, session, storage, and
generated schema runtime state initialized before server-rendered code runs.

Pass framework server options after `holo start` when your host assigns a specific interface or port:

```bash
holo start --hostname 0.0.0.0 --port 3072
```

If the deployment includes Holo workers, run them as separate supervised processes. Do not start queue or
broadcast workers from inside the web request process.

```bash
holo queue:work --connection redis
holo broadcast:work
```

Only run the workers the application actually uses.

## Run migrations intentionally

Do not treat schema changes as a hidden startup side effect in production.

A common deployment shape is:

1. run typecheck, lint, and tests
2. optionally run `holo config:cache`
3. build the application
4. deploy the artifact
5. run migrations or another approved schema step
6. switch traffic

## Environment-specific config

Keep credentials, URLs, disk bases, and logging rules in:

- env files during local or controlled environments
- provider env configuration in production
- server-only config

Do not expose secrets to browser-visible config or client bundles.

## Logging and safety

- keep SQL text redacted in production unless there is a specific operational need
- fail fast on unsupported or malformed runtime config
- keep config cache and generated artifacts server-only

## Validation before rollout

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

If docs changed:

```bash
npm run build:docs
```
