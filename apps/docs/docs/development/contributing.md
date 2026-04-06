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

Framework fixture apps used for smoke validation live under:

- `apps/Nuxt_test_app`
- `apps/Next_test_app`
- `apps/svelte_test_app`

When you promote a framework version for users, update the scaffold metadata and the matching fixture app
so the checked-in smoke target matches the scaffold default.

## Framework smoke validation

Use the built-in smoke suite before introducing a new framework version to users.

Validate all checked-in fixtures:

```bash
bun run test:smoke:frameworks
```

Validate one framework:

```bash
bun run test:smoke:frameworks -- --framework next
```

Validate a candidate framework version without committing the version bump:

```bash
bun run test:smoke:frameworks -- --framework next --dep next=^16.0.0
```

You can override multiple packages when a framework upgrade requires companion changes:

```bash
bun run test:smoke:frameworks -- --framework sveltekit \
  --dep @sveltejs/kit=^3.0.0 \
  --dep vite=^6.0.0
```

## What the smoke test does

The smoke script:

- temporarily patches the selected fixture app `package.json`
- runs `bun install`
- runs `holo prepare`
- runs `holo migrate:fresh --seed --force`
- builds the framework app
- boots the app and verifies health, matrix, storage, and media routes
- restores the original fixture manifest and `bun.lock`

Use `--dry-run` only to inspect the execution plan. It does not resolve or install the candidate version.

## Promotion rule

Do not bump scaffold metadata for a new framework version until the matching smoke validation passes.

A safe promotion flow is:

1. test the candidate version with `test:smoke:frameworks`
2. update `packages/cli/src/metadata.ts`
3. update the checked-in fixture app version
4. rerun the normal smoke suite
