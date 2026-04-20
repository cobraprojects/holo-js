# 403 Vs 404

Authorization distinguishes between a forbidden resource and a hidden resource.

## The two denial forms

- `deny()` produces a normal authorization failure.
- `denyAsNotFound()` produces a not-found style failure.

```ts
import { deny, denyAsNotFound } from '@holo-js/authorization'

if (!user) {
  return denyAsNotFound()
}

if (user.role !== 'admin') {
  return deny('Only admins can delete posts.')
}
```

## When to use 403

Use `403` when the caller is authenticated or known, but not allowed.

That is the normal authorization failure.

## When to use 404

Use `404` when the target should not be disclosed at all.

That is common for private records where you do not want to confirm their existence to unauthenticated users.

## Returning decisions

`inspect(...)` returns the structured decision, so your application decides how to map the result to a response.

```ts
const decision = await authorization.forUser(user).inspect('view', post)

if (!decision.allowed) {
  return Response.json({ message: decision.message }, { status: decision.status })
}
```

## Continue

- [Policies](/authorization/policies)
- [Standalone Mode](/authorization/standalone-mode)
- [Auth Integration](/authorization/auth-integrated-mode)
