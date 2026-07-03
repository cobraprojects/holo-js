# Realtime Optimization Evidence

This internal note records the current evidence for the realtime sync engine work. It is not a public API contract.

## Goal Invariants

- Final user-facing API remains `query`, `mutation`, `defineRealtimeQuery`, `defineRealtimeMutation`, and the existing client helpers.
- Client realtime does not require SSE or generated user routes.
- Query subscriptions share one canonical server result per query key.
- Supported mutation shapes patch subscribed results without rerunning the query handler.
- Unsupported shapes fall back to one shared refresh, not one refresh per subscriber.
- DB observation and mutation row capture stay inactive unless realtime/cache listeners need them.
- Client stores apply compact patch operations with structural sharing and stale-version guards.

## Evidence Matrix

| Requirement | Evidence |
| --- | --- |
| Shared canonical query state | `packages/realtime/src/runtime/query-state.ts`, `packages/realtime/src/runtime/subscription-index.ts`, and `packages/realtime/tests/realtime.benchmark.test.ts` scenario `records representative sync execution modes without per-subscriber reruns`. |
| Structured DB observations | `packages/db/tests/query-cache.test.ts` covers structured query observations, mutation events, projected observations, paginated observations, aggregate observations, and inactive observation helpers. |
| Patch result without rerunning supported queries | `packages/realtime/tests/realtime.benchmark.test.ts` covers list, projected rows, pagination, scalar, aggregate, grouped aggregate, relation, and selected previous-row value patch transport with `queryExecutions === 1`. |
| Compact patch transport | `packages/realtime/tests/patch-operations.test.ts`, `packages/realtime/tests/client-patching.test.ts`, and benchmark patch operation assertions cover replace, merge, splice, move, slide, compaction, and JSON-safe undefined replacement. |
| Client structural sharing | `packages/realtime/tests/realtime.client.test.ts` and `packages/realtime/tests/realtime.benchmark.test.ts` cover structural sharing for array rows, nested wrappers, nested relations, merge patches, moves, and paginated wrappers. |
| Realtime-only DB overhead | `packages/db/tests/query-cache.test.ts` covers normal writes staying off row capture without cache bridge/listeners and dependency helpers staying inert without listeners. |
| Safe fallback for unsupported queries | `packages/realtime/tests/realtime.benchmark.test.ts` covers unsupported shared fallback without per-subscriber reruns. Runtime fallback is in `packages/realtime/src/runtime/invalidation.ts` and `packages/realtime/src/runtime/patch-delivery.ts`. |
| No SSE or user route requirement | `tests/example-app-realtime-browser-flow.mjs` fails if `/holo/realtime/` is requested. `bun run test:example:blog-next` covers no-worker fallback and worker-backed browser realtime. |
| No final API change | `packages/realtime/tests/realtime.type.test.ts` and `packages/realtime/tests/realtime.declaration.test.ts` cover inferred user-facing query/mutation declarations. |

## Validation Commands

Use the existing package and integration checks for the current optimization evidence:

```sh
bun run typecheck
git ls-files --modified --others --exclude-standard | rg '\.(ts|tsx|js|jsx|mjs|cjs)$' | xargs npx eslint --fix
bun run test:dependency-policy
bun run test:example:blog-next
```

Run package-specific commands from their package directories, except root scripts such as `bun run typecheck`, `bun run test:dependency-policy`, the `git ls-files` lint command, and `bun run test:example:blog-next`.

## Current Audit Result

The realtime package has package-level 100% coverage for the sync engine paths. The latest targeted validation covered touched runtime source in `packages/realtime/src`, `packages/db/src`, `packages/broadcast/src`, and `packages/cli/src`.

Benchmark evidence currently includes `records representative sync execution modes without per-subscriber reruns`, which subscribes 250 clients per scenario and verifies:

- supported list patch: `queryExecutions === 1`, with one patch delivered to each subscriber;
- projected previous-row patch: `queryExecutions === 1`, with one patch delivered to each subscriber;
- aggregate merge patch: `queryExecutions === 1`, with one patch delivered to each subscriber;
- unsupported shared fallback: `queryExecutions === 2`, meaning one initial canonical execution and one shared refresh, not one refresh per subscriber.

The broader DB, broadcast, and CLI package-wide coverage thresholds are still not globally 100% in the current repository. Current package-wide coverage gaps are much larger than the realtime changes: DB has 23 files with uncovered paths, broadcast has 5, and CLI has 34. Treat that wider package coverage work as separate from the realtime engine behavior unless the coverage policy is changed to require global 100% for every touched package.
