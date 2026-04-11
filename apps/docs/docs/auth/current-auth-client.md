# Current Auth Client

`@holo-js/auth/client` provides lightweight client helpers for current-user state.

## Introduction

The client package is intentionally small. It does not implement authentication. It calls a current-auth endpoint
owned by your application and returns:

- `user()`
- `refreshUser()`
- `check()`

## Configuration

```ts
import { configureAuthClient } from '@holo-js/auth/client'

configureAuthClient({
  endpoint: '/api/auth/user',
})
```

Optional configuration:

- `endpoint`
- `guard`
- `headers`
- custom `fetch`

## Usage

```ts
import { check, refreshUser, user } from '@holo-js/auth/client'

const current = await user()
const authenticated = await check()
const fresh = await refreshUser()
```

`user()` may return cached state. `refreshUser()` forces a new request to the endpoint.

## Implementing The Endpoint

Your application implements the endpoint itself:

```ts
import { check, user } from '@holo-js/auth'

export async function GET() {
  return Response.json({
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  })
}
```

Guard-specific endpoint:

```ts
import auth from '@holo-js/auth'

export async function GET() {
  const guard = 'admin'

  return Response.json({
    authenticated: await auth.guard(guard).check(),
    guard,
    user: await auth.guard(guard).user(),
  })
}
```

## Error Handling

The client helpers throw when:

- the current-auth endpoint returns a non-2xx status
- the response body is not valid JSON
- no fetch implementation is available
