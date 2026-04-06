# Architecture

Holo-JS is split into a portable backend core plus thin framework adapters. The host framework still owns
SSR, routing, rendering, and deployment output.

## Runtime layers

1. config and env loading
2. discovery and generated registries
3. portable runtime and database context
4. model, storage, and media behavior
5. framework adapters

## Config and env loading

`@holo-js/config` owns:

- `config/*.ts` loading
- layered env resolution
- typed `useConfig(...)`
- typed `config(...)`
- config caching

This is the first runtime layer because everything else depends on it.

## Discovery and generated registries

Holo-JS, not the host framework, owns discovery of canonical directories such as:

- `server/models`
- `server/db`
- `server/commands`

`holo prepare` turns those directories into generated artifacts under `.holo-js/generated`. Adapters
consume those generated registries instead of re-scanning the filesystem on every runtime path.

## Portable runtime

`@holo-js/core` owns:

- config normalization
- runtime boot
- shared singleton handling
- database and storage access
- adapter contracts

The portable runtime is what makes framework support incremental instead of a redesign every time.

## Model, storage, and media packages

`@holo-js/db`, `@holo-js/storage`, and `@holo-js/media` live above the runtime core and below framework
adapters.

This layer owns:

- schema and query behavior
- models and relations
- migrations, factories, and seeders
- storage disks and media collections

## Framework adapters

The adapters are intentionally thin:

- `@holo-js/adapter-nuxt`
- `@holo-js/adapter-next`
- `@holo-js/adapter-sveltekit`

They should only solve framework glue:

- startup timing
- runtime access points
- generated registry consumption
- framework-specific server integration

They should not own database semantics, storage semantics, or their own config model.

## Hosting separation

Framework support and hosting support are separate concerns.

The adapter should stay free of direct assumptions about:

- Vercel
- Cloudflare
- VPS process managers
- Docker

That separation keeps future adapter work focused on framework runtime integration rather than provider
rewrites.

## Main architectural rule

Do not put framework-only behavior in the portable core, and do not put database or storage semantics in
the adapters.

If a change belongs to one framework only, keep it in the adapter. If it belongs to every framework,
keep it in shared packages.
