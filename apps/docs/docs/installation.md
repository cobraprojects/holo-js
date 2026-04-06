# Installation

The primary installation path is the package manager's `create` flow. It creates the project, asks the setup
questions up front, writes the hidden framework glue once, and leaves the user with configurable server-side config
files plus Holo-JS-owned server directories.

## Requirements

- Node 20 or newer
- Bun or another modern package manager
- one of: Nuxt, Next.js, or SvelteKit
- SQLite, Postgres, or MySQL

## Create a project interactively

::: code-group

```bash [Bun]
bun create holo-js my-app
```

```bash [npm]
npm create holo-js@latest my-app
```

```bash [pnpm]
pnpm create holo-js@latest my-app
```

```bash [Yarn]
yarn create holo-js my-app
```

```bash [Direct]
bunx create-holo-js my-app
```

:::

The interactive flow asks for:

- project name
- framework: `nuxt`, `next`, or `sveltekit`
- database driver: `sqlite`, `mysql`, or `postgres`
- package manager: `bun`, `npm`, `pnpm`, or `yarn`
- storage default disk: `local` or `public`
- optional packages: `validation`, `forms`, or none

## Create a project non-interactively

::: code-group

```bash [Bun]
bun create holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager bun \
  --storage-default-disk public \
  --package forms,validation
```

```bash [npm]
npm create holo-js@latest my-app -- \
  --framework next \
  --database sqlite \
  --package-manager npm \
  --storage-default-disk public \
  --package forms,validation
```

```bash [pnpm]
pnpm create holo-js@latest my-app -- \
  --framework next \
  --database sqlite \
  --package-manager pnpm \
  --storage-default-disk public \
  --package forms,validation
```

```bash [Yarn]
yarn create holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager yarn \
  --storage-default-disk public \
  --package forms,validation
```

```bash [Direct]
bunx create-holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager bun \
  --storage-default-disk public \
  --package forms,validation
```

:::

Do not use `bunx create holo-js`.
`bunx` treats `create` as the package name in that form, so it installs and runs the npm package named `create`
instead of resolving `create-holo-js`.

Use the non-interactive flags for CI, templates, or internal automation.

`forms` and `validation` are optional packages. Add them during scaffolding only if the app needs them.

## What the scaffold writes

The generated project contains:

- framework-owned files for the selected host framework
- `config/*.ts` for Holo-JS config
- layered env support with `.env` and `.env.example`
- canonical Holo-JS directories such as `server/models`, `server/db`, `server/commands`, `server/jobs`, `server/events`, and `server/listeners`
- first-party queue scaffold including `config/queue.ts` with `sync` as the default driver
- machine-owned generated output under `.holo-js/generated`
- framework lifecycle scripts such as `dev` and `build`

The generated framework glue is not the user-edited setup surface. After scaffolding, the normal places
to work are:

- `config/*.ts`
- `.env` and environment-specific env files
- `server/models`
- `server/db`
- `server/commands`
- `server/jobs`
- `server/events`
- `server/listeners`

## First commands

```bash
cd my-app
bun install
bun run dev
```

`bun run dev` already runs discovery first, refreshes `.holo-js/generated`, watches relevant files, and then
starts Nuxt, Next.js, or SvelteKit. Run `holo prepare` directly only when you want to regenerate discovery
artifacts without starting the dev server.

## Running Holo-JS commands inside a project

Use normal package scripts for framework lifecycle commands:

::: code-group

```bash [Bun]
bun run dev
bun run build
```

```bash [npm]
npm run dev
npm run build
```

```bash [pnpm]
pnpm dev
pnpm build
```

```bash [Yarn]
yarn dev
yarn build
```

:::

Use your package manager's exec wrapper for direct Holo-JS CLI commands:

::: code-group

```bash [Bun]
bunx holo make:model User
bunx holo migrate
bunx holo seed
```

```bash [npm]
npx holo make:model User
npx holo migrate
npx holo seed
```

```bash [pnpm]
pnpm dlx holo make:model User
pnpm dlx holo migrate
pnpm dlx holo seed
```

```bash [Yarn]
yarn dlx holo make:model User
yarn dlx holo migrate
yarn dlx holo seed
```

:::

`holo ...` by itself is not expected to be on your global shell path unless you install it globally.

## Host framework ownership

Holo-JS does not replace the host framework. The selected framework still owns:

- SSR
- routing
- page rendering
- hydration
- framework build output

Holo-JS owns:

- config loading
- layered env resolution
- database and ORM
- storage and media
- CLI workflows
- generated discovery registries
- backend flexibility across database drivers, storage drivers, and deployment targets

## Security defaults

- keep secrets in env files, never in client code
- keep `.env.example` limited to keys and placeholders
- keep `.holo-js/generated` gitignored
- do not move secret-bearing config into browser-visible runtime paths

## Continue

- [Configuration](/configuration)
- [Directory Structure](/directory-structure)
- [Queue](/queue/)
- [Events](/events/)
- [Development Workflow](/development/workflow)
- [Database Getting Started](/database/)
