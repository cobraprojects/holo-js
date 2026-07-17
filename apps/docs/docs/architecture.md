# Architecture

Holo-JS uses one-way package dependencies. Applications and framework adapters compose concrete capabilities; feature packages never reach upward into adapters or concrete drivers.

## Package layers

```text
@holo-js/kernel
        ↑
feature contracts and runtimes
        ↑
concrete drivers and framework adapters
        ↑
applications
```

`@holo-js/kernel` is dependency-free and owns project paths, plugin contracts and loading, and runtime lifecycle primitives. `@holo-js/config` owns environment loading, generic config-file loading, typed access, registry composition, and config caching. It does not import feature packages; installed features register their own normalizers when their config modules load.

Feature APIs are imported from the package that owns them. For example, use `defineAuthConfig` from `@holo-js/auth`, `defineQueueConfig` from `@holo-js/queue`, and `defineStorageConfig` from `@holo-js/storage`. Environment helpers continue to come from `@holo-js/config`.

## Runtime composition

`@holo-js/core` is the composition root. It discovers the project registry, loads validated kernel contributions, establishes subsystem order, and coordinates cleanup. Plugin filesystem and module-boundary validation live in the kernel so the CLI, config loader, and runtime follow one security policy.

Runtime contributions declare their dependencies. Initialization follows dependency order; a failed initialization disposes already-started contributions in reverse order.

## Drivers

Abstraction packages do not depend on concrete implementations. Install and import concrete drivers from their own packages:

- `@holo-js/db-sqlite`, `@holo-js/db-postgres`, or `@holo-js/db-mysql`
- `@holo-js/queue-redis`
- `@holo-js/storage-s3`

This direction lets drivers evolve independently and prevents package cycles.

## Framework adapters

The Next, Nuxt, and SvelteKit adapters own only framework-native startup, request, response, cookie, navigation, and build integration. Shared realtime source transformation lives in `@holo-js/adapter-shared` and uses the TypeScript AST, so all adapters accept the same syntax.

Framework routing, rendering, and deployment output remain owned by the host framework.

## Generated registries

Discovery converts canonical directories such as `server/models`, `server/db`, and `server/commands` into artifacts under `.holo-js/generated`. Adapters consume those registries instead of independently scanning application files.

## Architectural enforcement

The repository architecture check rejects:

- workspace dependency cycles
- undeclared Holo package imports
- imports from non-exported package subpaths
- Holo dependencies from the kernel
- abstraction-package dependencies on concrete drivers

Run it through `bun run test:dependency-policy`.
