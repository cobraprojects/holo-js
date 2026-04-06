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
bun run build
```

`holo prepare` refreshes discovery output. `holo config:cache` is optional but useful when you want
production to read cached config instead of resolving live files on startup.

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
bun run typecheck
bun run lint
bun run test
bun run build
```

If docs changed:

```bash
bun run build:docs
```
