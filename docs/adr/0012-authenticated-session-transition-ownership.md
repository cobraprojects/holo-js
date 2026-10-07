# Persist complete authenticated session transitions

Auth owns shared guard preservation, rotation, remember state, and failure recovery for authenticated session transitions, while framework adapters retain native cookie and request-context behavior under ADR-0001. Rotation persists the complete next payload through the existing store rotation operation, preserving private flash state and current successful auth behavior, including lifetime renewal and remember-token policy. We chose this over rotation followed by another creation because the intermediate persistent state makes transition failures harder to recover from.

Approved `RotateSessionOptions` shape:

```ts
interface RotateSessionOptions {
  readonly store?: string
  readonly newId?: string
  readonly data?: SessionRecord['data']
  readonly renewLifetime?: boolean
}
```

`AuthSessionRuntime.rotate` mirrors these fields using `AuthSessionRecord['data']`. Auth supplies the next payload and `renewLifetime: true`; ordinary rotation retains its current defaults. Auth rejects stores that cannot perform the required state-preserving rotation.

If remember-token issuance or cookie delivery fails after persistence, invalidate the new session and clear affected request identity while retaining the previous identifier's invalidation. Report the failure and any cleanup failures rather than reconstructing the previous session or promising a transaction across browser cookies and persistence.

Lifetime renewal clears the former remember hash in the rotated record. Auth reissues a token for remembered or explicitly preserved transitions. Ordinary rotation keeps its timestamps and remember state. MFA recovery can restore a challenge lease only while the former session still exists; a persisted transition failure never reconstructs it.
