# Installation

The primary installation path is the package manager's `create` flow. It creates the project, asks the setup
questions up front, writes the hidden framework glue once, and leaves the user with configurable server-side config
files plus Holo-JS-owned server directories.

## Requirements

- Node 20 or newer
- a modern package manager (npm, pnpm, yarn, or bun)
- one of: Nuxt, Next.js, or SvelteKit
- SQLite, Postgres, or MySQL

## Create a project interactively

::: code-group

```bash [npm]
npm create holo-js@latest my-app
```

```bash [pnpm]
pnpm create holo-js@latest my-app
```

```bash [Yarn]
yarn create holo-js my-app
```

```bash [Bun]
bun create holo-js my-app
```

:::
- storage default disk: `local` or `public`
- optional packages: `validation`, `forms`, `security`, `notifications`, `mail`, `storage`, `events`, `queue`, `cache`, `auth`, `authorization`, `broadcast`, or none

## Create a project non-interactively

::: code-group

```bash [npm]
npm create holo-js@latest my-app -- \
  --framework next \
  --database sqlite \
  --package-manager npm \
  --storage-default-disk public \
  --package forms,validation,mail
```

```bash [pnpm]
pnpm create holo-js@latest my-app -- \
  --framework next \
  --database sqlite \
  --package-manager pnpm \
  --storage-default-disk public \
  --package forms,validation,mail
```

```bash [Yarn]
yarn create holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager yarn \
  --storage-default-disk public \
  --package forms,validation,mail
```

```bash [Bun]
bun create holo-js my-app \
  --framework next \
  --database sqlite \
  --package-manager bun \
  --storage-default-disk public \
  --package forms,validation,mail
```

:::

Use the non-interactive flags for CI, templates, or internal automation.

`validation`, `forms`, `security`, `notifications`, `mail`, `storage`, `events`, `queue`, `cache`, `auth`, `authorization`, and `broadcast` are optional packages. Add them during scaffolding only if the
app needs them.

Example optional package sets include `--package forms,validation,notifications`,
`--package forms,validation,mail`, `--package forms,validation,security`, and `--package authorization`.

Authorization can also be installed after scaffolding:

```bash
npx holo install authorization
```

Broadcast setup is installed after scaffolding:

```bash
npx holo install broadcast
```

Cache setup can also be installed after scaffolding:

```bash
npx holo install cache
```

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

After scaffolding, install dependencies and start the dev server using the package manager you selected:

::: code-group

```bash [npm]
cd my-app
npm install
npm run dev
```

```bash [pnpm]
cd my-app
pnpm install
pnpm dev
```

```bash [Yarn]
cd my-app
yarn install
yarn dev
```

```bash [Bun]
cd my-app
bun install
bun run dev
```

:::

`npm run dev` (or the equivalent for your package manager) already runs discovery first, refreshes `.holo-js/generated`, watches relevant files, and then
starts Nuxt, Next.js, or SvelteKit. Run `holo prepare` directly only when you want to regenerate discovery
artifacts without starting the dev server.

## Running Holo-JS commands inside a project

Use normal package scripts for framework lifecycle commands:

::: code-group

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

```bash [Bun]
bun run dev
bun run build
```

:::

Use your package manager's exec wrapper for direct Holo-JS CLI commands:

::: code-group

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

```bash [Bun]
bunx holo make:model User
bunx holo migrate
bunx holo seed
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
- [Notifications](/notifications/)
- [Mail](/mail/)
- [Broadcast](/broadcast/)
- [Cache](/cache/)
- [Development Workflow](/development/workflow)
- [Database Getting Started](/database/)
