# Holo-JS Framework

> A configurable full backend framework for Nuxt, Next.js, and SvelteKit.

Holo-JS gives your app a typed database layer, storage layer, media library, events subsystem, generated
discovery, and a single configuration model built around `config/*.ts` and layered `.env` files. The host framework keeps
owning SSR, routing, rendering, and deployment output, while Holo-JS keeps backend concerns configurable
across database drivers, storage drivers, and deployment targets.

## What Holo-JS owns

- configurable server-side config files such as `config/app.ts`, `config/database.ts`, and `config/storage.ts`
- layered env loading through `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.prod`, and `.env.test`
- canonical server directories such as `server/models`, `server/db`, `server/commands`, `server/jobs`, `server/events`, `server/listeners`, `server/broadcast`, and `server/channels`
- typed discovery artifacts under `.holo-js/generated`
- internal runtime and CLI scratch files under `.holo-js/runtime`
- database commands, migrations, seeders, factories, storage, and media workflows
- flexible database and storage composition without rewriting application logic
- deployment portability across VPS, Docker, Vercel, Cloudflare, and other supported hosts

## Supported frameworks

- Nuxt
- Next.js
- SvelteKit

## Create a project

Interactive:

```bash
npm create holo-js@latest my-app
```

Non-interactive:

```bash
npm create holo-js@latest my-app -- \
  --framework next \
  --database sqlite \
  --package-manager npm \
  --storage-default-disk public
```

Equivalent create-package entrypoints:

```bash
pnpm create holo-js@latest my-app
yarn create holo-js my-app
npx create-holo-js my-app
```

That scaffold writes the framework glue once. After that, the user-facing setup surface is:

- `config/*.ts`
- `.env` and its environment-specific variants
- `server/models`
- `server/db`
- `server/commands`
- `server/jobs`
- `server/events`
- `server/listeners`
- `server/broadcast`
- `server/channels`

## Typical app shape

```text
my-app/
├── config/
│   ├── app.ts
│   ├── database.ts
│   └── storage.ts
├── server/
│   ├── commands/
│   ├── db/
│   ├── events/
│   ├── jobs/
│   ├── listeners/
│   └── models/
├── storage/
├── .env
├── .env.example
└── .holo-js/generated/
```

## Core commands

Use your package manager's run command for framework lifecycle:

```bash
npm run dev
npm run build
npm run start
```

Use your package manager's exec wrapper for direct Holo-JS CLI commands:

```bash
npx holo prepare
npx holo config:cache
npx holo config:clear
npx holo migrate
npx holo seed
```

`holo dev` and `holo build` run discovery before handing control to the selected framework.
`holo start` starts the production server with Holo runtime preloads before handing off to Nuxt,
Next.js, or SvelteKit.
`holo prepare` is available when you want to regenerate typed registries without starting dev or build.

 Across Nuxt, Next.js, and SvelteKit, request handlers run with the runtime context prepared by framework bootstrap.
Use the public config accessors directly:

```ts
import { useConfig, config } from '@holo-js/config'

const services = useConfig('services')
const secret = config('services.mailgun.secret')
```

The framework route wrapper stays native, while runtime APIs remain framework-neutral.

Equivalent exec forms: `npx holo ...`, `pnpm dlx holo ...`, `yarn dlx holo ...`, `bunx holo ...`.

## Flexible runtime

Holo-JS is designed so application code stays stable while infrastructure changes underneath it:

- switch database drivers through config instead of rewriting models
- combine any supported database driver with any supported storage driver
- keep storage and database concerns independent
- deploy on any host the selected framework can target

## Monorepo structure

```text
holo-js/
├── packages/
│   ├── config/             # @holo-js/config - config loading, env layering, typed access
│   ├── core/               # @holo-js/core - portable runtime core and adapter contract
│   ├── adapter-nuxt/       # @holo-js/adapter-nuxt - Nuxt adapter
│   ├── adapter-next/       # @holo-js/adapter-next - Next.js adapter
│   ├── adapter-sveltekit/  # @holo-js/adapter-sveltekit - SvelteKit adapter
│   ├── db/                 # @holo-js/db - database, ORM, migrations, seeders, factories
│   ├── events/             # @holo-js/events - event contracts, listeners, dispatch, runtime orchestration
│   ├── broadcast/          # @holo-js/broadcast - broadcast definitions, channels, worker runtime, drivers
│   ├── flux/               # @holo-js/flux - framework-agnostic realtime client
│   ├── flux-react/         # @holo-js/flux-react - React/Next helpers for Flux
│   ├── flux-vue/           # @holo-js/flux-vue - Vue/Nuxt composables for Flux
│   ├── flux-svelte/        # @holo-js/flux-svelte - Svelte/SvelteKit helpers for Flux
│   ├── mail/               # @holo-js/mail - mail definitions, preview, attachments, and fluent delivery
│   ├── notifications/      # @holo-js/notifications - notification contracts, channels, and fluent delivery
│   ├── storage/            # @holo-js/storage - storage runtime and config
│   ├── media/              # @holo-js/media - media collections and conversions
│   └── cli/                # holo-js - project creation and operational commands
├── apps/
│   └── docs/               # documentation site
└── docs/                   # implementation plans and internal docs
```

## Repo development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run test:coverage
```

### Dependency version policy

Generated user projects must use publishable dependency ranges for `@holo-js/*` packages, for example `^0.1.4`.
Do not scaffold `workspace:*` into user apps.

Committed apps under `apps/` are repo examples and test fixtures. They must use `workspace:*` for local
`@holo-js/*` packages so app validation runs against the current workspace code. They must also use `catalog:` for
dependencies that exist in the root workspace catalog.

CLI dependency sync must preserve the app's existing Holo dependency mode. If an app already uses `workspace:*` for
any `@holo-js/*` package, newly managed `@holo-js/*` packages must also use `workspace:*`; otherwise they must use the
current publishable Holo range.

This policy is enforced by `scripts/validate-dependency-version-policy.mjs`, which runs as part of `bun run test`.

For docs work:

```bash
bun run dev:docs
bun run build:docs
```

## Security rules

- keep secrets in env files, never in client bundles
- keep `.env.example` limited to key names and placeholders
- treat `.holo-js/generated` and `.holo-js/runtime` as machine-owned and gitignored
- keep secret-bearing config server-only

## License

MIT
