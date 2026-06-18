# Deployment

Deployment should be configuration-driven and predictable. Holo-JS stays portable by separating framework
support from hosting support.

The goal is simple: configure backend infrastructure once, keep application code stable, and deploy
anywhere the selected framework can run.

## Baseline model

Use Node or server output as the baseline mental model. Then let the selected host framework adapt that
to the hosting provider.

That keeps Holo-JS portable across:

- VPS and Docker
- Vercel
- Cloudflare
- other framework-supported hosts

Database and storage choices stay independent in that model. A project can change one without forcing a
rewrite of the other.

## Prepare artifacts deliberately

For deployable artifacts, keep these steps explicit:

```bash
holo prepare
holo config:cache
npm run build
```

`holo prepare` refreshes discovery output. `holo config:cache` is optional but useful when you want
production to read cached config instead of resolving live files on startup.

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

Use `holo start` in process managers such as PM2, systemd, Docker, or Forge instead of calling the
framework production entrypoint directly. That keeps database, auth, session, storage, and generated schema
runtime state initialized before server-rendered code runs.

## Run migrations intentionally

Do not treat schema changes as a hidden startup side effect in production.

A common deployment shape is:

1. run typecheck, lint, and tests
2. run `holo prepare`
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
