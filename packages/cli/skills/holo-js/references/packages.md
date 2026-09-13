# Holo-JS package catalog

Use this catalog when choosing a package or locating its authoritative documentation. Each workspace package has a concrete use case and a direct documentation page; do not send an agent to a broad documentation homepage to discover it.

| Package | Use case | Direct documentation |
| --- | --- | --- |
| `@holo-js/adapter-next` | Next.js request, response, validation, auth, and runtime integration | [Runtime services](https://docs.holo-js.com/runtime-services) |
| `@holo-js/adapter-nuxt` | Nuxt and Nitro server/client integration and composables | [Runtime services](https://docs.holo-js.com/runtime-services) |
| `@holo-js/adapter-shared` | Shared contracts used by framework adapters | [Architecture](https://docs.holo-js.com/architecture) |
| `@holo-js/adapter-sveltekit` | SvelteKit hooks, locals, actions, and client integration | [Runtime services](https://docs.holo-js.com/runtime-services) |
| `@holo-js/auth` | Local authentication, guards, sessions, passwords, tokens, MFA, and verification | [Authentication](https://docs.holo-js.com/auth/) |
| `@holo-js/auth-clerk` | Clerk-backed authentication provider | [Clerk](https://docs.holo-js.com/auth/clerk) |
| `@holo-js/auth-social` | Shared OAuth social-login contracts and orchestration | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-apple` | Sign in with Apple provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-discord` | Discord OAuth provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-facebook` | Facebook OAuth provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-github` | GitHub OAuth provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-google` | Google OAuth provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-social-linkedin` | LinkedIn OAuth provider | [Social login](https://docs.holo-js.com/auth/social-login) |
| `@holo-js/auth-workos` | WorkOS-backed enterprise authentication | [WorkOS](https://docs.holo-js.com/auth/workos) |
| `@holo-js/authorization` | Abilities, policies, and resource authorization | [Authorization](https://docs.holo-js.com/authorization/) |
| `@holo-js/broadcast` | Broadcast events, channels, authorization, and drivers | [Broadcasting](https://docs.holo-js.com/broadcast/) |
| `@holo-js/cache` | Cache contracts, stores, tags, and runtime access | [Cache](https://docs.holo-js.com/cache/) |
| `@holo-js/cache-db` | Database-backed cache driver | [Cache drivers](https://docs.holo-js.com/cache/config-and-drivers) |
| `@holo-js/cache-redis` | Redis-backed cache driver | [Cache drivers](https://docs.holo-js.com/cache/config-and-drivers) |
| `@holo-js/cli` | Project generation, package setup, migrations, workers, and operations | [CLI agent install](https://docs.holo-js.com/cli/agents-install) |
| `@holo-js/config` | Typed environment and application configuration | [Configuration](https://docs.holo-js.com/configuration) |
| `@holo-js/core` | Framework application, service contracts, errors, and shared runtime APIs | [Architecture](https://docs.holo-js.com/architecture) |
| `@holo-js/db` | Schema definitions, query builder, ORM models, relations, and transactions | [Database](https://docs.holo-js.com/database/) |
| `@holo-js/db-mysql` | MySQL database driver | [Database](https://docs.holo-js.com/database/) |
| `@holo-js/db-postgres` | PostgreSQL database driver | [Database](https://docs.holo-js.com/database/) |
| `@holo-js/db-sqlite` | SQLite database driver | [Database](https://docs.holo-js.com/database/) |
| `@holo-js/events` | Domain events, listeners, queued listeners, and after-commit dispatch | [Events](https://docs.holo-js.com/events/) |
| `@holo-js/flux` | Framework-neutral reactive server-state APIs | [Flux and frameworks](https://docs.holo-js.com/broadcast/flux-and-frameworks) |
| `@holo-js/flux-react` | React bindings for Flux state | [Flux and frameworks](https://docs.holo-js.com/broadcast/flux-and-frameworks) |
| `@holo-js/flux-svelte` | Svelte bindings for Flux state | [Flux and frameworks](https://docs.holo-js.com/broadcast/flux-and-frameworks) |
| `@holo-js/flux-vue` | Vue bindings for Flux state | [Flux and frameworks](https://docs.holo-js.com/broadcast/flux-and-frameworks) |
| `@holo-js/forms` | Shared form contracts and browser form state | [Forms](https://docs.holo-js.com/forms/) |
| `@holo-js/kernel` | Application boot, provider lifecycle, manifests, and runtime orchestration | [Architecture](https://docs.holo-js.com/architecture) |
| `@holo-js/mail` | Mail definitions, templates, attachments, drivers, previews, and queueing | [Mail](https://docs.holo-js.com/mail/) |
| `@holo-js/media` | Model-attached media collections, conversions, and queued processing | [Media](https://docs.holo-js.com/media) |
| `@holo-js/notifications` | Multi-channel, stored, queued, and on-demand notifications | [Notifications](https://docs.holo-js.com/notifications/) |
| `@holo-js/queue` | Jobs, workers, retry policy, failed jobs, and queue contracts | [Queues](https://docs.holo-js.com/queue/) |
| `@holo-js/queue-db` | Database-backed queue driver | [Database queues](https://docs.holo-js.com/queue/database) |
| `@holo-js/queue-redis` | Redis-backed queue driver | [Queues](https://docs.holo-js.com/queue/) |
| `@holo-js/realtime` | Realtime server and WebSocket protocol integration | [Realtime](https://docs.holo-js.com/realtime/) |
| `@holo-js/security` | CSRF, encryption, hashing, rate limiting, and secure request utilities | [Security](https://docs.holo-js.com/security) |
| `@holo-js/session` | Session stores, cookies, flash data, and request session lifecycle | [Sessions and cookies](https://docs.holo-js.com/auth/session-and-cookies) |
| `@holo-js/storage` | Storage disks and file operations | [Storage](https://docs.holo-js.com/storage) |
| `@holo-js/storage-s3` | S3-compatible storage driver | [Storage](https://docs.holo-js.com/storage) |
| `@holo-js/validation` | Typed schemas, rules, validation errors, and request validation | [Validation](https://docs.holo-js.com/validation/) |
| `create-holo-js` | Scaffold a new Holo-JS application | [Installation](https://docs.holo-js.com/installation) |
