# Packages

Holo-JS is split into small packages so you only install what your app uses. New projects get the core packages and your framework's adapter. [`npx holo install`](/getting-started/installation#add-packages-to-an-existing-project) adds most of the others for you, along with their config files.

All `@holo-js/*` packages are released together with the same version number. Keep them on the same version.

## Always installed

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/cli` | The `holo` command: scaffolding, generators, migrations, workers | Every project | [CLI Commands](/reference/cli) |
| `@holo-js/config` | Loads `config/` files and `.env` files; `env()`, `useConfig()`, `config()` | Every project | [Configuration](/getting-started/configuration) |
| `@holo-js/core` | Starts the Holo runtime and connects the installed packages | Every project | [How Holo Works](/advanced/architecture) |
| `@holo-js/kernel` | Shared contracts, `defineRedisConfig`, and the plugin API | Every project; import from it directly when configuring Redis or writing plugins | [Writing Plugins](/advanced/plugins) |
| `@holo-js/db` | Database connections, query builder, ORM models, migrations, seeders, factories | Every project | [Database](/database/), [ORM](/orm/) |

## Framework adapters

Install the one for your framework. The installer adds it for you.

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/adapter-next` | `withHolo()` for `next.config.ts`, plus client helpers | Next.js apps | [Next.js](/getting-started/frameworks/next) |
| `@holo-js/adapter-nuxt` | The Nuxt module, plus client composables | Nuxt apps | [Nuxt](/getting-started/frameworks/nuxt) |
| `@holo-js/adapter-sveltekit` | `withHoloSvelteKit()` for the `sveltekit()` options in `vite.config.ts`, plus client helpers | SvelteKit apps | [SvelteKit](/getting-started/frameworks/sveltekit) |
| `@holo-js/adapter-shared` | Code shared by the three adapters | Installed automatically; you don't import it | — |

## Database drivers

Install one for each database engine your `config/database.ts` uses.

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/db-sqlite` | SQLite driver | `driver: 'sqlite'` | [Database](/database/) |
| `@holo-js/db-postgres` | PostgreSQL driver | `driver: 'postgres'` | [Database](/database/) |
| `@holo-js/db-mysql` | MySQL driver | `driver: 'mysql'` | [Database](/database/) |

## Requests, forms, and security

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/validation` | `schema()`, `field`, and validation rules | Validating any user input | [Validation](/basics/validation/) |
| `@holo-js/forms` | `validate()` for form submissions and typed form errors | Handling HTML or JS form posts | [Forms](/basics/forms/) |
| `@holo-js/security` | CSRF protection, rate limiting, CORS | Apps with forms or public APIs | [Security](/basics/security/) |
| `@holo-js/session` | Cookie-backed sessions with file, database, or Redis storage | Apps with sign-in; installed with `auth` | [Sessions](/basics/session) |

## Authentication and authorization

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/auth` | Login, registration, guards, password reset, email verification, MFA, API tokens | Apps with user accounts | [Authentication](/auth/) |
| `@holo-js/auth-social` | Shared support for OAuth social login | Any social login provider | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-google` | Google login | Sign in with Google | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-github` | GitHub login | Sign in with GitHub | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-discord` | Discord login | Sign in with Discord | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-facebook` | Facebook login | Sign in with Facebook | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-apple` | Apple login | Sign in with Apple | [Social Login](/auth/social-login) |
| `@holo-js/auth-social-linkedin` | LinkedIn login | Sign in with LinkedIn | [Social Login](/auth/social-login) |
| `@holo-js/auth-workos` | WorkOS hosted sign-in | Using WorkOS for identity | [WorkOS](/auth/workos) |
| `@holo-js/auth-clerk` | Clerk hosted sign-in | Using Clerk for identity | [Clerk](/auth/clerk) |
| `@holo-js/authorization` | Policies, abilities, `authorize()` | Deciding who can do what | [Authorization](/authorization/) |

## Background work and messaging

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/queue` | Jobs, `dispatch()`, workers, failed jobs | Running work in the background | [Queues](/queue/) |
| `@holo-js/queue-db` | Database queue driver and database failed-job storage | Queues stored in your database | [Drivers and Tables](/queue/drivers) |
| `@holo-js/queue-redis` | Redis queue driver | Queues stored in Redis | [Drivers and Tables](/queue/drivers) |
| `@holo-js/events` | Events, listeners, queued and after-commit listeners | Decoupling side effects from your main code | [Events](/events/) |
| `@holo-js/mail` | Mail definitions, Markdown mail, previews, SMTP | Sending email | [Mail](/mail/) |
| `@holo-js/notifications` | Notifications over email, database, broadcast, or custom channels | Notifying users | [Notifications](/notifications/) |

## Cache and files

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/cache` | Cache API, locks, query caching; file and memory stores | Caching values or queries | [Cache](/cache/) |
| `@holo-js/cache-db` | Database cache store | Cache stored in your database | [Cache Drivers](/cache/drivers) |
| `@holo-js/cache-redis` | Redis cache store | Cache stored in Redis | [Cache Drivers](/cache/drivers) |
| `@holo-js/storage` | `Storage` disks: local and public files, public file URLs | Reading and writing files | [File Storage](/storage/) |
| `@holo-js/storage-s3` | S3 and S3-compatible disk driver | Files on S3, R2, MinIO, and similar | [Amazon S3](/storage/s3) |
| `@holo-js/media` | Attach files to models, with collections and image conversions | Avatars, post images, uploads tied to records | [Media Library](/media/) |

## Realtime

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `@holo-js/broadcast` | Broadcast events, channels, and the WebSocket server (`holo broadcast:work`) | Pushing server events to browsers | [Broadcasting](/broadcasting/) |
| `@holo-js/flux` | Browser client for broadcast channels and presence | Listening for broadcasts in the browser | [Listening on the Client](/broadcasting/client) |
| `@holo-js/flux-react` | React hooks for Flux | Next.js apps using broadcasting | [Listening on the Client](/broadcasting/client) |
| `@holo-js/flux-vue` | Vue composables for Flux | Nuxt apps using broadcasting | [Listening on the Client](/broadcasting/client) |
| `@holo-js/flux-svelte` | Svelte helpers for Flux | SvelteKit apps using broadcasting | [Listening on the Client](/broadcasting/client) |
| `@holo-js/realtime` | Queries and mutations whose results update live in the browser | Live dashboards, feeds, and lists | [Realtime Queries](/realtime/) |

## Project creation

| Package | What it's for | When you need it | Docs |
| --- | --- | --- | --- |
| `create-holo-js` | Runs `npm create holo-js` / `pnpm create holo-js` / `yarn create holo-js` / `bun create holo-js` | Creating a new project; never added to your app | [Installation](/getting-started/installation) |

## Next steps

- [Installation](/getting-started/installation): add packages with `holo install`
- [Upgrade Guide](/getting-started/upgrading)
