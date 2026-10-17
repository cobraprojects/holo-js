# Contributing to Holo-JS

This page is for contributors working on the Holo-JS monorepo.

Use it when you are changing packages under `packages/`, updating scaffold metadata, validating framework
adapters, or testing candidate framework versions before they are exposed to users.

If you are building a Holo-JS application, use [Application Development](/development/) instead.

## Core contributor loop

```bash
bun install
bun run check
```

`check` runs typechecking, linting, all library suites against real services, and the Next, Nuxt,
and SvelteKit example journeys across SQLite, PostgreSQL, and MySQL. Package-only tests are useful
while editing, but do not replace `check` for shared-package changes.

`bun run test` includes `test:ci` (all native library suites and all nine framework/database journeys)
and the published-package, scaffold, and browser-bundle acceptance checks. `bun run test:ci` runs
the CI suites directly. CI calls the same `test:libraries` and `test:examples` scripts, rather than
maintaining separate test commands.

`bun run test:platform` runs the native package loading and server lifecycle tests using the same
command as the CI platform matrix. Those tests also run within `test:libraries`. A local run covers
the current OS and Node version; CI additionally runs them on Linux, Windows, and macOS with
Node 22.12.0, 24, and 26.

The native suites need PostgreSQL on port 5432 with the `postgres` user, MySQL on port 3306 with
the `root` user and an empty password, Redis on port 6379, and the `redis-server` executable.
Install the browser used by the journeys with `bun x playwright install chromium` (add
`--with-deps` on Linux). Missing services fail `check`.

Use `bun run test:coverage` when investigating behavior coverage; coverage is diagnostic, not a
push threshold. CI also checks supported Node versions on Linux, Windows, and macOS.

For docs work:

```bash
bun run dev:docs
bun run build:docs
```

## Where framework versions are defined

Scaffolded framework versions are declared in:

- `packages/cli/src/metadata.ts`

User-facing framework examples live under:

- `apps/blog-nuxt`
- `apps/blog-next`
- `apps/blog-sveltekit`

Keep their configuration, lifecycle scripts, and framework integration aligned with newly scaffolded projects.

## Framework smoke validation

Use the scaffold user-journey smoke before introducing a framework or scaffolder change to users.

The smoke test creates a fresh application for every supported framework:

```bash
bun run test:smoke:scaffold
```

Run the user-facing feature and API examples separately:

```bash
bun run test:examples
```

## What the smoke test does

The smoke script:

- builds the local Holo packages
- runs the public `holo new` command for Nuxt, Next.js, and SvelteKit
- installs the generated project dependencies
- verifies the managed `.holo-js` structure
- adds and runs a database migration
- runs linting and framework typechecking
- creates a production build
- boots each app and verifies its rendered home page

## Promotion rule

Do not bump scaffold metadata for a new framework version until the matching smoke validation passes.

A safe promotion flow is:

1. update `packages/cli/src/metadata.ts`
2. run `test:smoke:scaffold`
3. run `test:examples`
4. run the normal validation suite
