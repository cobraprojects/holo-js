# Holo-JS Framework

> A configurable full backend framework for Nuxt, Next.js, and SvelteKit.

Holo-JS gives your app a typed database layer, storage layer, media library, events subsystem, generated
discovery, and a single configuration model built around `config/*.ts` and layered `.env` files. The host framework keeps
owning SSR, routing, rendering, and deployment output, while Holo-JS keeps backend concerns configurable
across database drivers, storage drivers, and deployment targets.

## What Holo-JS owns

- configurable server-side config files such as `config/app.ts`, `config/database.ts`, and `config/storage.ts`
- layered env loading through `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.prod`, and `.env.test`
- canonical server directories such as `server/models`, `server/db`, `server/commands`, `server/jobs`, `server/events`, and `server/listeners`
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
bun create holo-js my-app
```

Non-interactive:

```bash
bun create holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager bun \
  --storage-default-disk public
```

Equivalent create-package entrypoints:

```bash
npm create holo-js@latest my-app
bunx create-holo-js my-app
```

Do not use `bunx create holo-js`.
`bunx` treats `create` as the package name in that form, so it installs and runs the npm package named `create`
instead of resolving `create-holo-js`.

That scaffold writes the framework glue once. After that, the user-facing setup surface is:

- `config/*.ts`
- `.env` and its environment-specific variants
- `server/models`
- `server/db`
- `server/commands`
- `server/jobs`
- `server/events`
- `server/listeners`

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

```bash
bun install
bun run dev
bun run build
bunx holo prepare
bunx holo config:cache
bunx holo config:clear
bunx holo migrate
bunx holo seed
```

`holo dev` and `holo build` run discovery before handing control to the selected framework.
`holo prepare` is available when you want to regenerate typed registries without starting dev or build.

Across Nuxt, Next.js, and SvelteKit, the shared Holo-JS server helper is:

```ts
const app = await holo.getApp()
```

The framework route wrapper stays native, but Holo-JS access stays consistent.

Inside a project, use:

- `bun run dev` / `bun run build` for framework lifecycle commands
- `bunx holo ...` for direct Holo-JS CLI commands such as `make:model`, `migrate`, and `seed`

Equivalent direct CLI forms are `npx holo ...`, `pnpm dlx holo ...`, and `yarn dlx holo ...`.

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
