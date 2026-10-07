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

## Queue finalization ownership

The Queue worker owns the outcome of a reserved job separately from adapter finalization.
Handler errors determine retry, release, or terminal failure; acknowledgement and release each
have one mutation path. Terminal finalization persists the failed job before deleting its
reservation. Any adapter error stops `runQueueWorker` with the original error, without retrying
the mutation or reclassifying it as a handler failure. Delivery may repeat according to driver
reservation semantics.

Completion hooks run before acknowledgement, and processed hooks follow successful
acknowledgement. Timeout handling suppresses late lifecycle hooks without promising handler
cancellation. See [Queue Workers](/queue/workers#delivery-and-finalization-failures).

## Architectural enforcement

The repository architecture check rejects:

- workspace dependency cycles
- undeclared Holo package imports
- imports from non-exported package subpaths
- Holo dependencies from the kernel
- abstraction-package dependencies on concrete drivers

Run it through `bun run test:dependency-policy`.

## Auth Token Redemption

Email verification owns one atomic claim of the exact unused, unexpired token and invokes the user mutation only for the winner. Core uses an operation-scoped native repository and actual database context identity to prove shared transaction participation. Participating failures roll back the claim and user update together. External providers and different database contexts consume the claim before mutation; failure requires a fresh token. See [Email Verification](/auth/email-verification#single-use-redemption).

Password-reset redemption and its scoped sibling-revocation coordination remain approved pending implementation. The shared decision is recorded in ADR-0008.


## Browser Session Revocation

Auth owns browser validity independently of the physical session store. Standalone applications may inject a durable `AuthSessionRevocationStore`; requesting other-device logout without it fails explicitly. Distinct provider/user identities are read together, with reuse scoped to native request ownership. A logical browser identity survives physical rotation and an atomic generation transition retains the current browser while invalidating the selected identity on other browsers' next authenticated request.

This leaves unrelated identities and personal access tokens valid. Remember restoration and saved impersonation originals must pass the same validity check before trust. Applications own recent reauthentication policy. Hosted-provider revocation applies to Holo authentication; it does not revoke upstream Clerk or WorkOS sessions. Core's default database adapter and scaffold migration remain pending. See [Session And Cookies](/auth/session-and-cookies#custom-revocation-adapters) and ADR-0015.
