# Application Development Workflow

This page is for application teams using Holo-JS inside their own app.

A good Holo-JS workflow keeps config, discovery, and database state explicit.

If you are working on the Holo-JS monorepo itself, use [Contributing to Holo-JS](/development/contributing)
instead.

## Start from config, not framework glue

Set app behavior through:

- `config/*.ts`
- `.env`
- `.env.local`
- `.env.development`

Do not hide Holo-JS setup inside custom framework bootstrap files. The scaffolded glue should stay
machine-owned.

## Keep discovery current

Use `holo prepare` whenever you need to regenerate discovery output directly.

```bash
holo prepare
```

In normal day-to-day work:

- `holo dev` runs discovery first and watches Holo-JS-owned files
- `holo build` runs discovery first and then starts the framework build

## Prepare the database deliberately

A healthy local loop usually includes:

- running migrations explicitly
- seeding known baseline data
- resetting local data when a feature needs a clean state

Do not depend on accidental app startup behavior to mutate the database for you.

## Use realistic data locally

Prefer a small but representative local data set:

- a few users with distinct roles
- enough records to make pagination and filtering meaningful
- realistic related data for model and route work

Factories and seeders are the right place to keep that setup repeatable.

## Cache config only when it helps

Development and test usually use live config loading. Production can use cached config if you choose.

```bash
holo config:cache
holo config:clear
```

If the cache is present, Holo-JS uses it. If not, Holo-JS falls back to `config/*.ts` plus layered env
files.

## Validate before merge

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

If documentation changed:

```bash
npm run build:docs
```

## Keep operational steps explicit

- do not quietly run production schema changes at boot
- do not hard-code credentials or local-only paths
- do not expose secrets to client code
- do not edit `.holo-js/generated` manually
