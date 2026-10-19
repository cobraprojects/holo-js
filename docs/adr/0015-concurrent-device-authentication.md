# Permit concurrent device authentication with explicit revocation

Implementation status: personal access token independence, `tokens.revokeOthers`, current-token logout, and standalone browser revocation through the injectable Auth adapter are delivered. Core default database revocation persistence, Auth scaffold migration, and real database/file/Redis session integration are delivered.

A user may maintain multiple independent personal access tokens and browser sessions, following Sanctum's concurrent-token model and Laravel's browser-session behavior. Logging in or issuing a token does not revoke authentication on other devices; developers may explicitly request revocation of other authentication credentials while retaining the current one. We chose developer-controlled revocation over implicit single-device authentication so ordinary login and session transitions do not disrupt unrelated devices.

Single-use email-verification and password-reset redemption remains separate under ADR-0008. Other-browser-session revocation and other-personal-access-token revocation are separate developer-invoked operations; revoking browser sessions does not implicitly revoke mobile or automation tokens. Both retain the current credential.

Browser revocation targets the selected provider/user identity and preserves unrelated identities in shared sessions. For Clerk and WorkOS, its scope is existing Holo sessions, not upstream provider sessions; a still-valid upstream session may authenticate again. Native upstream revocation requires separately supported provider behavior.

Token-guard logout revokes only the current personal access token before clearing its request identity. Session-guard logout clears the current guard's browser authentication; other-device revocation remains explicit. The existing `logoutAll` retains its current-request guard scope rather than becoming an all-device operation.

Approved additions to the session-only auth facade and personal access token facade:

```ts
logoutOtherDevices(): Promise<void>

revokeOthers(options?: { readonly guard?: string }): Promise<number>
```

The default auth facade and session guards expose `logoutOtherDevices`; registered token guards do not. Both operations require currently valid authentication and derive the identity and retained credential from that request. Applications control recent-password or hosted reauthentication requirements.

Approved extension to `AuthTokenStore`, retaining existing calls:

```ts
deleteByUserId(
  provider: string,
  userId: string | number,
  options?: { readonly exceptId?: string },
): Promise<number>
```

Token revocation uses one conditional deletion rather than listing and deleting tokens individually.

Browser validity belongs to an auth-owned durable revocation module rather than session-store enumeration or forced password rehashing. The logical session identity survives physical session-ID rotation; all selected provider/user identities in the same browser use that identity. Revocation atomically advances the identity's generation and retains the current logical session. A caller already invalidated by another revocation cannot make itself the survivor.

Approved injectable adapter and binding:

```ts
interface AuthSessionIdentity {
  readonly provider: string
  readonly userId: string | number
}

interface AuthSessionRevocationState extends AuthSessionIdentity {
  readonly generation: number
  readonly retainedSessionId?: string
}

interface AuthSessionRevocationStore {
  readMany(
    identities: readonly AuthSessionIdentity[],
  ): Promise<readonly AuthSessionRevocationState[]>

  revokeOthers(
    identity: AuthSessionIdentity,
    currentSession: {
      readonly id: string
      readonly generation: number
    },
  ): Promise<boolean>
}
```

`AuthRuntimeBindings` gains optional `sessionRevocations?: AuthSessionRevocationStore`. Standalone auth can inject an adapter; requesting other-device logout without one fails explicitly. The adapter returns current state for each distinct requested identity, with an explicit generation-zero state when no durable revocation exists. An omitted requested identity is an adapter contract failure, not evidence of generation zero. Authentication accepts the current generation or the retained logical session, checks remember-cookie restoration too, and batches distinct identity reads for reuse within a native request scope. A memory auth context belongs to one request; asynchronous auth contexts and framework wrappers preserving native async accessors retain that ownership. Custom contexts without proven native request ownership use fresh batched reads rather than sharing stale state across requests. Saved impersonation originals retain their original generation and logical identity and must pass validity checks before restoration. Revocation invalidates other identities on their next authenticated request rather than physically scanning or deleting every session record.

Core supplies a database adapter through `auth_session_revocations`, keyed by `(provider, user_id)`, with string provider and user identifiers, integer `generation`, and nullable string `retained_session_id`. New scaffolds include its migration, and existing applications need the migration when adopting that adapter. The same auth validity module works with database, file, and Redis sessions.

Enabling the revocation adapter rejects authenticated browser payloads that lack its logical session identity and generation, including payloads restored from remember cookies. Those users must sign in again; no compatibility fallback infers revocation metadata for an older authenticated payload. Existing personal access tokens remain valid. Subsequent ordinary login and rotation preserve independent authentication on other devices.

References: [Sanctum authentication and token revocation](https://laravel.com/framework/docs/13.x/sanctum), [Laravel other-device session invalidation](https://laravel.com/framework/docs/13.x/authentication#invalidating-sessions-on-other-devices).

## Amendment: remember-me tokens follow Laravel's per-user model

Under ADR-0016, remember-me restoration uses one `remember_token` per user, as Laravel does, instead of a credential on the browser session record. The encrypted remember cookie carries the user identifier, the token, and a SHA-256 digest of the password hash; session-guard logout and password reset cycle the token. Cycling ends remember-me restoration on every device, but it does not revoke active browser sessions on other devices, which remain governed by explicit other-device logout. We accepted this narrower cross-device effect for Laravel parity and so that a remember credential no longer expires with its session. Other-device logout also cycles the token and reissues the current browser's remember cookie, so browsers it revokes cannot sign back in through remember-me, which Laravel achieves by rehashing the password. A remember cookie is issued only after a multi-factor challenge succeeds. Restoration copies the browser session's data into a new session and sends its cookie instead of rotating the old one, so a framework that cannot write cookies during rendering, such as Next.js server components, leaves the browser's session intact; private flash values in the old session are not carried over. While another guard's multi-factor challenge is pending, restoration authenticates only the current request and leaves the browser on the challenge session. When the framework cannot write cookies in the current request, such as a Next.js Server Component render, restoration authenticates that request only and persists no session records; explicit login and logout there fail with the cookie-write error instead of reporting success. Restoring several guards in one request reuses the session already established for that request, and a remember cookie is rejected when another device cycles its token while its restoration is reading revocation state.

Custom `AuthRuntimeContext` implementations may expose `getRequestScope(): object`, returning one stable object per request and a fresh object for each request. Remember-cookie reads and guard restoration are cached only with a proven request scope. Without one, reads remain uncached and callers must restore remembered guards sequentially. Remember-cookie writes require a scope and fail with `runtime_unconfigured` before authentication changes; this prevents a later write from reintroducing an entry cleared earlier in the same request. Remember accessors remain optional; scoped cookie state supplies their default. This extension was approved by the user for #112 on 2026-10-19.
