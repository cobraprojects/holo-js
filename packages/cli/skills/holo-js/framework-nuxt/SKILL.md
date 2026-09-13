---
name: holo-framework-nuxt
description: Integrate Holo-JS with Nuxt and Nitro handlers, plugins, request context, auth, validation composables, navigation, and Vue Flux state.
metadata:
  type: focused
  source: https://docs.holo-js.com/runtime-services
---

# Nuxt integration

Use `@holo-js/adapter-nuxt`. Read [runtime services](https://docs.holo-js.com/runtime-services), [routing](https://docs.holo-js.com/routing), [form framework integration](https://docs.holo-js.com/forms/framework-integration), and [current auth client](https://docs.holo-js.com/auth/current-auth-client).

## Integration rules

- Boot Holo through the documented Nuxt/Nitro plugin and module boundary.
- Resolve services from the current event or request context; do not share request state globally.
- Put cross-runtime schemas in `shared` code and keep database or credential-bearing modules server-only.
- Use the adapter's server validation and form composables so error shapes remain consistent.
- Use Nuxt navigation and Nitro response APIs. Authentication owns cookie side effects.
- Use `@holo-js/flux-vue` for Vue client state driven by Holo realtime updates.

## Completion check

- Nuxt auto-imports and generated types resolve through the Nuxt TypeScript configuration.
- Client bundles exclude server packages.
- Tests cover Nitro response behavior, redirects, cookies, validation errors, and request-scope isolation.
