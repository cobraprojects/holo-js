---
name: holo-js
description: Build, convert, debug, or review Holo-JS applications. Routes work to focused Holo-JS skills for forms, ORM, auth, storage, media, queues, events, observers, broadcasting, realtime, mail, notifications, framework adapters, testing, and deployment.
metadata:
  type: router
  library: holo-js
  library_version: 0.3.15
  source: https://docs.holo-js.com/architecture
---

# Holo-JS

Treat Holo-JS like Laravel. Use the framework's first-party APIs as the application architecture, not as thin wrappers around a parallel custom system.

## Start here

1. Follow the user's requested architecture and scope.
2. Follow the current official Holo-JS conventions.
3. Preserve an application's conventions only where they agree with the first two rules.
4. Read the focused skill that owns the task before editing code.
5. Add a second focused skill only when the work crosses a real subsystem boundary.

Application code never imports `internal` paths. Prefer public package exports and preserve inferred types from schema or model definition through adapters and consumers.

## Route the task

| Work | Read | Documentation |
| --- | --- | --- |
| Forms, schemas, browser/server validation | [forms-validation](forms-validation/SKILL.md) | [framework integration](https://docs.holo-js.com/forms/framework-integration) |
| Tables, models, queries, relations, scopes, observers | [database-orm](database-orm/SKILL.md) | [ORM](https://docs.holo-js.com/orm/) |
| Authentication, authorization, sessions, security | [auth-security](auth-security/SKILL.md) | [Authentication](https://docs.holo-js.com/auth/) |
| Storage disks, uploads, media collections | [storage-media](storage-media/SKILL.md) | [Media](https://docs.holo-js.com/media) |
| Jobs, queues, domain events, listeners | [queues-events](queues-events/SKILL.md) | [Events](https://docs.holo-js.com/events/) |
| Broadcast events, channels, sockets, realtime | [broadcast-realtime](broadcast-realtime/SKILL.md) | [Broadcasting](https://docs.holo-js.com/broadcast/) |
| Mail, notification channels, delivery | [mail-notifications](mail-notifications/SKILL.md) | [Notifications](https://docs.holo-js.com/notifications/) |
| Application boot, config, services, cache, routing, plugins | [application-runtime](application-runtime/SKILL.md) | [Architecture](https://docs.holo-js.com/architecture) |
| Next.js integration | [framework-next](framework-next/SKILL.md) | [Runtime services](https://docs.holo-js.com/runtime-services) |
| Nuxt integration | [framework-nuxt](framework-nuxt/SKILL.md) | [Runtime services](https://docs.holo-js.com/runtime-services) |
| SvelteKit integration | [framework-sveltekit](framework-sveltekit/SKILL.md) | [Runtime services](https://docs.holo-js.com/runtime-services) |
| Tests, configuration, CLI, deployment | [testing-deployment](testing-deployment/SKILL.md) | [Testing](https://docs.holo-js.com/testing) |
| Replace custom or legacy architecture with Holo | [convert-to-holo](lifecycle/convert-to-holo/SKILL.md) | [Upgrade architecture](https://docs.holo-js.com/upgrade-architecture) |
| Package choice, ownership, or install question | [package catalog](references/packages.md) | Read the direct link in the matching package row |

## Universal rules

- Inspect `package.json`, Holo config, the selected framework adapter, and nearby tests before choosing APIs.
- Use installed Holo package versions as the implementation boundary. Documentation describes intent; exported runtime code and declarations confirm availability.
- If docs and installed exports disagree, report the documented API and installed package version. Inspect only that package's public `exports` and exported declarations. If no supported public equivalent exists, stop and report the incompatibility.
- Preserve the inference chain. Do not widen concrete public types to `any`, `unknown`, or `never` to satisfy the checker.
- Validate untrusted data at the system boundary, authorize the action, and only then perform side effects.
- Use transactions when several writes must succeed together. Dispatch after commit when listeners depend on committed state.
- Prefer Holo services from request or application context over constructing drivers in handlers.
- Do not invent compatibility wrappers around unclear behavior. Resolve the correct package or adapter integration.

## Completion check

- The implementation uses public Holo exports and the correct adapter boundary.
- Failure, authorization, transaction, and cleanup behavior are covered where relevant.
- Tests assert observable behavior and inferred public types.
- Commands, imports, package names, and direct documentation links match the installed version.
