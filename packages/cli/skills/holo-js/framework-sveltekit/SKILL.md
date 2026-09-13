---
name: holo-framework-sveltekit
description: Integrate Holo-JS with SvelteKit hooks, locals, load functions, form actions, auth, validation, redirects, and Svelte Flux state.
metadata:
  type: focused
  source: https://docs.holo-js.com/runtime-services
---

# SvelteKit integration

Use `@holo-js/adapter-sveltekit`. Read [runtime services](https://docs.holo-js.com/runtime-services), [routing](https://docs.holo-js.com/routing), [form framework integration](https://docs.holo-js.com/forms/framework-integration), and [current auth client](https://docs.holo-js.com/auth/current-auth-client).

## Integration rules

- Initialize request context in the documented SvelteKit hook and expose request-scoped services through locals.
- Keep shared schemas in browser-safe modules and use `$lib/server` for database, secrets, mail, and drivers.
- Validate actions through the adapter and return the documented structured failure shape.
- Use SvelteKit `redirect`, `fail`, and error APIs. Authentication owns cookie side effects.
- Clean up subscriptions established during a request or component lifecycle.
- Use `@holo-js/flux-svelte` for Svelte client state driven by Holo realtime updates.

## Completion check

- Hooks, locals, load functions, actions, and client modules use the correct runtime boundary.
- Server packages do not enter the browser bundle.
- Tests cover action status, failures, redirects, cookies, validation errors, and locals isolation.
