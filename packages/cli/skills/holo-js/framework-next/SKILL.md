---
name: holo-framework-next
description: Integrate Holo-JS with Next.js route handlers, server actions, request context, auth, validation, forms, redirects, and client Flux state.
metadata:
  type: focused
  source: https://docs.holo-js.com/runtime-services
---

# Next.js integration

Use `@holo-js/adapter-next`. Read [runtime services](https://docs.holo-js.com/runtime-services), [routing](https://docs.holo-js.com/routing), [form framework integration](https://docs.holo-js.com/forms/framework-integration), and [current auth client](https://docs.holo-js.com/auth/current-auth-client).

## Integration rules

- Initialize the Holo application and adapter at the documented server boundary, not inside every route.
- Resolve request-scoped services from the adapter context.
- Keep shared schemas in browser-safe modules; keep database, secrets, mail, and drivers server-only.
- Route handlers and server actions validate with the adapter integration and preserve structured form errors.
- Use Next.js native `redirect` and navigation APIs. Authentication owns cookie side effects.
- Use `@holo-js/flux-react` for React client state driven by Holo realtime updates.

## Completion check

- Server-only packages cannot enter the client graph.
- Route handlers, server actions, middleware, and React clients use their intended boundaries.
- Tests cover response status, redirects, cookies, validation errors, and request-scope isolation.
