# Persist complete authenticated session transitions

Auth owns shared guard preservation, rotation, remember state, and failure recovery for authenticated session transitions, while framework adapters retain native cookie and request-context behavior under ADR-0001. Rotation persists the complete next payload through the existing store rotation operation, preserving private flash state and current successful auth behavior, including lifetime renewal and remember-token policy. We chose this over rotation followed by another creation because the intermediate persistent state makes transition failures harder to recover from.

Redis stores keep one key per session with no Redis Cluster hash tag, matching Laravel's key layout and spreading sessions across Cluster slots. A rotation then spans two keys, which Cluster can't update in one script. Redis rotation copies the session, including its private flash state, to the new key, then deletes the old key only if it still holds the copied state, so a flash value taken during the copy is consumed once and never restored on the new identifier. This leaves the intermediate state the previous paragraph avoids: if the process stops between the copy and the delete, both identifiers exist until the old key's expiry, and the old identifier stays valid until then. Transition failure handling invalidates the previous identifier as described above, but a Redis rotation that fails after the copy can't guarantee that on its own.

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
