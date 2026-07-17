# Contributing to Holo-JS

This page is for contributors working on the Holo-JS monorepo.

Use it when you are changing packages under `packages/`, updating scaffold metadata, validating framework
adapters, or testing candidate framework versions before they are exposed to users.

If you are building a Holo-JS application, use [Application Development](/development/) instead.

## Core contributor loop

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
