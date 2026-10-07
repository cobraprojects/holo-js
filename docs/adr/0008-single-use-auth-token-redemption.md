# Coordinate single-use auth token redemption with persistence outcomes

Email verification is implemented and behaviorally verified. Password-reset redemption, including sibling revocation coordination, remains approved pending implementation in ticket #85.

Exactly one concurrent request may redeem an email verification or password reset token. When the token and user mutation share a database transaction, a failed mutation rolls back both; when the user belongs to an external provider adapter, a claimed token remains consumed after mutation failure and the user must request a fresh token. We chose adapter-specific guarantees because a transaction across unrelated persistence adapters would promise atomicity the implementation cannot provide.

The existing token stores retain creation, lookup, and revocation operations and gain a required redemption operation. A matching token must still be unused and unexpired when claimed; an unavailable claim returns `null`, and only its winner invokes the operation. Custom stores must implement this behavior rather than falling back to lookup followed by unconditional deletion.

Approved addition to `EmailVerificationTokenStore`:

```ts
redeem<TResult>(
  record: EmailVerificationTokenRecord,
  operation: () => Promise<TResult>,
): Promise<TResult | null>
```

Approved addition to `PasswordResetTokenStore`:

```ts
redeem<TResult>(
  record: PasswordResetTokenRecord,
  operation: () => Promise<TResult>,
): Promise<TResult | null>
```

The concrete callback result remains inferred. Shared transaction participation must be proven by the persistence wiring; the callback shape alone does not establish that guarantee. Core resolves the native repository for the redemption operation and binds that same repository to its participating update. Actual database context identity determines participation; repository duck typing and equal connection names do not. Repository factories retain their lifetime across separate operations. Core uses the existing database temporal normalization for known auth timestamp fields. Native pooled PostgreSQL timestamp parsing and MySQL session/parsing use UTC by default, and redemption compares expiry against the database statement clock. This also works when auth tables predate the current process and have no loaded model metadata.

The single-winner guarantee applies per token, including when different valid password-reset tokens target the same email; no account-wide lock spans external provider operations. Password-reset sibling revocation retains its existing provider, email, and broker-table scope and occurs before user mutation. For external providers, those revocations remain permanent if mutation fails; proven shared-database participation rolls them back with the claim and user mutation.

This redemption decision applies to email verification and password reset, not reusable personal access tokens or browser sessions.
