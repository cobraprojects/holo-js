---
layout: home
title: Holo-JS Documentation
titleTemplate: false
hero:
  name: Holo-JS
  text: Build server-backed apps with Nuxt, Next.js, or SvelteKit.
  tagline: Holo-JS brings configurable backend services, typed database and storage layers, and generated discovery while the host framework keeps SSR and routing.
  actions:
    - theme: brand
      text: Install Holo-JS
      link: /installation
    - theme: alt
      text: Configure your app
      link: /configuration
---

## What Holo-JS gives you

Holo-JS owns backend runtime concerns: config loading, layered env files, model discovery, migrations,
seeders, storage, media, and typed runtime access. Nuxt, Next.js, and SvelteKit still own routing, SSR,
rendering, and deployment output. The result is a configurable backend layer that stays flexible across
database drivers, storage drivers, and hosting targets.

::: code-group

```bash [Bun]
bun create holo-js my-app
cd my-app
bun run dev
```

```bash [npm]
npm create holo-js@latest my-app
cd my-app
npm run dev
```

```bash [pnpm]
pnpm create holo-js@latest my-app
cd my-app
pnpm dev
```

```bash [Yarn]
yarn create holo-js my-app
cd my-app
yarn dev
```

:::

```ts
// config/database.ts
import { defineDatabaseConfig } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: './storage/database.sqlite',
    },
  },
})
```

The user-facing setup surface stays small: `config/*.ts`, layered env files, `server/models`,
`server/db`, `server/commands`, `server/jobs`, `server/events`, `server/listeners`, and `server/mail`.

## Supported frameworks

- Nuxt
- Next.js
- SvelteKit

## Start here

- [Installation](/installation)
- [Configuration](/configuration)
- [Directory Structure](/directory-structure)
- [Application Development](/development/)

## Working on Holo-JS itself

These docs mostly describe how to build apps with Holo-JS.

If you are contributing to the framework packages inside this repository, use:

- [Contributing to Holo-JS](/development/contributing)

## Core guides

- [Architecture](/architecture)
- [Routing](/routing)
- [Runtime Services](/runtime-services)
- [Validation](/validation/)
- [Forms](/forms/)
- [Events](/events/)
- [Notifications](/notifications/)
- [Mail](/mail/)
- [Storage](/storage)
- [Queue](/queue/)
- [Media](/media)
- [Security](/security)

## Backend workflow

- `bun create holo-js` scaffolds the project and asks for framework, database, package manager, and storage defaults.
- `holo prepare` scans Holo-JS-owned directories and regenerates typed registries under `.holo-js/generated`.
- `config/queue.ts` is scaffolded by default and starts on the `sync` driver.
- `holo dev` reruns discovery, watches Holo-JS files, and then starts the selected framework.
- `holo build` refreshes discovery before the framework build.
- `holo config:cache` and `holo config:clear` manage production config caching.

## Flexible by design

- use the same model and query APIs across supported database drivers
- pair any supported storage driver with any supported database driver
- keep backend infrastructure configurable through server-side config
- deploy anywhere the selected host framework can run

## Build your data layer

- [Database Getting Started](/database/)
- [Database Commands](/database/commands)
- [Query Builder](/database/query-builder/)
- [Pagination](/database/pagination)
- [Migrations](/database/migrations)
- [Seeding](/database/seeding)
- [ORM Getting Started](/orm/)
- [ORM Relationships](/orm/relationships)
- [Mutators & Casts](/orm/mutators-casts)
- [Factories](/orm/factories)

## Ship safely

- [Testing](/testing)
- [Deployment](/deployment)
- [Security](/security)

## Validate and submit

- [Validation Overview](/validation/)
- [Validation Rules And Errors](/validation/rules-and-errors)
- [Forms Overview](/forms/)
- [Server Validation](/forms/server-validation)
- [Client Usage](/forms/client-usage)
- [Framework Integration](/forms/framework-integration)
