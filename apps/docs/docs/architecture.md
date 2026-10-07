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

## Realtime row windows

Realtime owns shared mutation metadata, projection checks, relation hydration, and patch preparation inside its row-window runtime. Standard rows defer a limited refill until the mutation batch is applied; wrappers refill as each mutation changes their window; offset windows patch stable updates locally and fetch the bounded page when its membership or ordering changes. Cursor windows retain their lookahead and next-page boundary. Aggregate and relation algorithms keep their own policies.

Selected cursor results include only their selected fields, including after inserts and updates. Hidden-field updates leave visible results unchanged. Patching preserves unaffected projected rows where possible and shares cached reads across patch targets. Unsupported shapes fall back to the original query rather than widening an optimized fetch or returning an incomplete result. See [Realtime pagination](./realtime/index.md#pagination).
## Approved ownership designs

::: info Pending implementation
Optional capability lifetime ownership, email-verification and password-reset redemption, Queue finalization, authenticated session transitions, Realtime row-window orchestration, Media attachment/replacement ownership, and Flux presence membership are implemented. The remaining designs below are approved for future implementation; their new interfaces and failure guarantees remain pending.
:::

These changes deepen existing modules by concentrating behavior behind their interfaces. Existing framework-native request, cookie, redirect, and navigation ownership remains with each framework adapter.

| Module | Approved ownership | Behavior to preserve or establish |
| --- | --- | --- |
| Auth token redemption (implemented) | One-time claim and user mutation coordination | One winner per verification or reset token; participating database changes roll back together |
| Optional capability lifetime (implemented) | Initialization, owned-resource disposal, and restoration | Continue cleanup after failures, collect errors, and preserve live external bindings |
| Queue reserved job (implemented) | Outcome selection and one finalization path | Adapter finalization failures stop the worker without becoming handler retries |
| Authenticated session transition (implemented) | Complete payload rotation, shared guards, and recovery | Preserve lifetime renewal, private flash state, and remember policy; fail closed after transition failure |
| Realtime row window (implemented) | Shared patch preparation and mutation orchestration | Preserve ordering, page contents, structural sharing, bounded fetching, and avoided query reruns |
| Media mutation (attachment/replacement implemented; regeneration/deletion pending) | File compensation and record commitment | Compensate before transaction commitment; retain committed results after cleanup or dispatch failure |
| Flux presence membership (implemented) | Shared membership rules with native framework adapters | Preserve inference, per-event snapshots, and distinct first-match versus all-match removal policies |

### One-time auth token redemption

Email-verification and password-reset stores use the required `redeem<TResult>(record, operation): Promise<TResult | null>` operation. It claims a matching, unused, unexpired token and invokes the operation only for the winner. Unavailable claims return `null`; custom stores implement this operation instead of assembling lookup and unconditional deletion.

Core uses an operation-scoped native repository and actual database context identity to prove shared transaction participation. Participating failures roll back the claim and user update together. External providers and different database contexts consume the claim before mutation; failure requires a fresh token. See [Email Verification](/auth/email-verification#single-use-redemption).

Password-reset redemption applies the same single-winner claim and persistence guarantees. Sibling revocation is scoped to provider, email, and broker table and runs before user mutation: a proven shared transaction rolls all three back on failure, while external providers retain the claim and revocations. See [Password Reset](/auth/password-reset#single-use-redemption) and ADR-0008. Different reset tokens do not introduce an account-wide lock across external operations. Reusable personal access tokens and browser sessions retain independent multi-device authentication.

### Capability lifetime and Queue outcomes

Core's private capability lifetime modules use the existing kernel lifecycle. Disposal and rollback continue after individual failures, close only Holo-owned resources, and restore prior live bindings for every capability Holo changes. A single disposal failure retains its original error; multiple failures produce an `AggregateError`, and failed startup includes both initialization and rollback failures. Queue asynchronous shutdown closes all owned drivers and resets its state even when closure fails. Closed resources are not restored. Asynchronous error reporting from synchronous Queue configuration and reset is outside this change.

Queue handler retry rules remain intact. Acknowledgement, release, or terminal persistence failures reject the worker with the original adapter error; finalization does not re-enter handler retry logic. Job completion hooks still precede acknowledgement, while worker processed hooks follow successful acknowledgement.

### Authenticated session transitions

Session rotation gains optional `data` and `renewLifetime` fields. Auth supplies the complete next payload with lifetime renewal through the existing store rotation operation; ordinary rotation retains its defaults. Auth rejects stores that cannot perform the required state-preserving rotation.

If remember-token issuance or cookie delivery fails after persistence, invalidate the new session and clear every affected guard's request identity while keeping the old identifier invalidated. Report cleanup failures alongside the original failure. Other devices remain authenticated.

Developer-controlled other-device logout is documented in [Session And Cookies](/auth/session-and-cookies). Independent token revocation is documented in [Personal Access Tokens](/auth/personal-access-tokens).

### Realtime and Media outcomes

Realtime keeps its existing internal interfaces and distinct window policies. Shared orchestration stays private; the refactor must preserve result correctness and query budgets.

The private Media mutation module owns attachment and replacement ordering, database commitment,
file compensation, and post-commit outcomes. It uses the database's existing transaction hooks:
record saves do not establish commitment until the enclosing transaction commits. Attachment
failure and outer rollback compensate file writes; obsolete-file cleanup and queued dispatch run
after commitment and retain committed records and new files when they fail.

Native error causes retain individual failures, and `AggregateError` retains the primary transaction
failure together with failed rollback compensation. The successful Media interface remains unchanged.
Regeneration and explicit deletion ownership are pending; this delivered attachment behavior is
recorded in [ADR-0011](https://github.com/cobraprojects/holo-js/blob/main/docs/adr/0011-media-mutation-commit-and-compensation.md).

### Flux adapter integration

The existing `fluxInternals` export provides generic `appendPresenceMember` and `removePresenceMember` methods taking a readonly member array and one member and returning a readonly array of the same inferred member type. Comparison stays private. Framework adapters remove the first matching member, while core removal retains its all-match policy; native effects, refs, stores, and cleanup stay with each adapter. Per-event membership callbacks retain separate immutable snapshots, and custom subscriptions use only public subscription methods. [ADR-0014](https://github.com/cobraprojects/holo-js/blob/main/docs/adr/0014-flux-presence-membership-ownership.md) records this boundary.

### Verification through module interfaces

Verification must protect concurrent token claims, transaction outcomes, continued cleanup after failures, Queue finalization errors, session failure recovery, and current-device preservation. Realtime tests retain real database checks for correct pages and bounded reads; Media tests verify file and record outcomes with local persistence. Native Flux adapter tests continue to exercise framework lifecycle behavior. Existing behavior tests remain valuable; redundant plumbing tests can be replaced when the deeper interface protects the same behavior.

