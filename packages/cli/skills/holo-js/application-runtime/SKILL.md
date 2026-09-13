---
name: holo-application-runtime
description: Configure and boot Holo-JS applications, resolve runtime services, use cache and locks, follow host-framework routing, or author Holo plugins.
metadata:
  type: focused
  source: https://docs.holo-js.com/architecture
---

# Application runtime

Read [architecture](https://docs.holo-js.com/architecture), [configuration](https://docs.holo-js.com/configuration), [runtime services](https://docs.holo-js.com/runtime-services), [routing](https://docs.holo-js.com/routing), [cache](https://docs.holo-js.com/cache/), and [plugin authoring](https://docs.holo-js.com/plugins).

## Ownership

- `@holo-js/core` exposes application and service contracts.
- `@holo-js/kernel` boots the application, discovers registered modules, and loads plugin contributions.
- `@holo-js/config` loads typed configuration and environment values.
- The host framework owns route matching, HTTP responses, rendering, and navigation.
- Holo owns backend services used inside those handlers.

```ts
import { config, useConfig } from '@holo-js/config'

const services = useConfig('services')
const mailgunSecret = config('services.mailgun.secret')
```

## Cache

Use `@holo-js/cache` for computed values, locks, and query caching. Choose `memory` or `file` for one-process or local needs, Redis for shared application nodes, and database when the database should own the shared cache.

```ts
import cache from '@holo-js/cache'

const report = await cache.remember('reports.daily', 300, async () => {
  return await buildDailyReport()
})
```

Use locks around work that must have one active owner. Cache data remains disposable; the database remains the source of truth.

## Plugins

Plugins expose a package-local `holo.plugin` entry and a `defineHoloPlugin` definition. Keep contribution module paths inside the package root. Register feature-specific config normalization in the feature package, add the package to `config/app.ts`, and run `holo prepare` after activation changes.

## Completion check

- Boot and request-scoped state live at the adapter boundary.
- Config access remains typed and secrets stay out of logs and browser bundles.
- Cache keys, expiry, invalidation, lock behavior, and deployment scope are explicit.
- Plugin IDs and contribution names are unique, and every module path remains package-relative.
