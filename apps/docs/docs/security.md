# Security

Holo-JS defaults to the safe path. Unsafe operations remain possible, but they are explicit, visibly
named, and separately typed.

## The main security rule

The common path should stay parameterized, validated, and metadata-aware without developers needing to
remember every rule manually.

## Default safety model

In the normal path:

- values become bindings
- identifiers are validated against metadata where possible
- raw SQL remains outside the fluent safe APIs
- compiled statements carry debug metadata instead of ad hoc SQL strings
- query logs redact SQL unless visibility is intentionally enabled

## SQL safety

- identifiers are validated against metadata where possible
- values become bindings, not interpolated SQL
- raw SQL requires explicit unsafe markers
- SQL text is redacted in logs unless debug visibility is enabled

## Unsafe APIs stay separate

Unsafe SQL is supported when it is genuinely needed, but it should be impossible to miss in code review:

```ts
await DB.executeUnsafe(
  DB.raw('VACUUM'),
)
```

Unsafe builders and raw statements carry explicit naming so they are easy to audit. They are not quiet
escape hatches attached to the safe query surface.

## Runtime policy controls

Security policy can cap maximum query complexity, control raw SQL behavior, and decide whether SQL text is
visible in logs for a given connection.

This is usually configured per environment:

- safer defaults in production
- more visibility in local debugging

## Logging and visibility

Production-safe defaults keep SQL text redacted. When you enable runtime DB logging intentionally,
queries and transaction lifecycle events become visible for that connection.

That is useful for debugging, but it should be treated as an operational choice, not a permanent default.

## Migration and schema safety

Schema sync is previewable before application. Unsupported schema mutations fail closed instead of being
guessed.

## Validation failures are part of the contract

Holo-JS prefers failing early over silently widening risk:

- malformed identifiers are rejected before execution
- unsupported operators are rejected before compilation
- unsupported dialect operations fail closed
- malformed migration metadata is rejected instead of guessed

That bias is deliberate. A framework should not quietly reinterpret intent when the operation is close to
the database boundary.
