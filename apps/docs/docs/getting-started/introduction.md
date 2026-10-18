# Introduction

Holo-JS is a backend framework that runs inside your Next.js, Nuxt, or SvelteKit app. It gives you the server-side pieces those frameworks leave to you: a database layer and ORM, validation, authentication, queues, mail, file storage, and more.

If you have used Laravel or Rails, Holo will feel familiar: models, migrations, jobs, events, and a `holo` CLI that generates and runs them.

## The problem Holo solves

Next.js, Nuxt, and SvelteKit are excellent at routing and rendering. They don't ship a database layer, a job queue, or an auth system. Most teams assemble these from separate libraries, each with its own config style, its own conventions, and its own glue code per framework.

Holo replaces that assembly work with one consistent toolkit:

- One `config/` folder and one set of `.env` files for every backend feature.
- One CLI for scaffolding, migrations, workers, and maintenance.
- Typed APIs end to end. A column you add in a migration autocompletes in your route handler.
- The same backend code works in all three frameworks.

## What Holo handles and what your framework handles

Holo does not replace your framework. You still write pages, layouts, and routes the way your framework expects.

| Your framework handles | Holo handles |
| --- | --- |
| Routing and URL matching | Database connections, queries, and models |
| Page rendering, SSR, and hydration | Migrations and seeders |
| Route handlers, server actions, `load` functions | Validation and form handling |
| Client-side navigation and redirects | Sessions, authentication, and authorization |
| Build output and deployment adapters | Queues, events, mail, and notifications |
| | Cache, file storage, and media |
| | Broadcasting and realtime queries |
| | Config loading and `.env` files |

In practice, you call Holo from your framework's server code. A Next.js route handler, a Nuxt event handler, and a SvelteKit `load` function can all run the same `Post.where(...)` query.

## Features

| Feature | What it does | Docs |
| --- | --- | --- |
| Database | Connections, migrations, seeders, transactions, and a query builder for SQLite, Postgres, and MySQL | [Database](/database/) |
| ORM | Typed models with relationships, scopes, casts, observers, and factories | [ORM](/orm/) |
| Validation | Schemas that validate input on the server and the client | [Validation](/basics/validation/) |
| Forms | Form submission helpers with typed errors for each framework | [Forms](/basics/forms/) |
| Security | CSRF protection, rate limiting, and CORS | [Security](/basics/security/) |
| Sessions | Cookie-backed sessions stored in files, the database, or Redis | [Sessions](/basics/session) |
| Authentication | Login, registration, email verification, password reset, MFA, API tokens, social login, WorkOS, and Clerk | [Authentication](/auth/) |
| Authorization | Policies and abilities for deciding who can do what | [Authorization](/authorization/) |
| Queues | Background jobs with sync, database, or Redis drivers | [Queues](/queue/) |
| Events | Domain events and listeners, optionally queued | [Events](/events/) |
| Mail | Mail classes, Markdown mail, previews, and SMTP delivery | [Mail](/mail/) |
| Notifications | Send messages over email, database, broadcast, or custom channels | [Notifications](/notifications/) |
| Cache | Key-value cache, locks, and cached queries | [Cache](/cache/) |
| Storage | Local, public, and S3-compatible disks | [File Storage](/storage/) |
| Media | Attach files to models, with image conversions | [Media Library](/media/) |
| Broadcasting | Push server events to browsers over WebSockets | [Broadcasting](/broadcasting/) |
| Realtime | Query results that update in the browser when data changes | [Realtime Queries](/realtime/) |
| CLI | Create projects, generate files, run migrations and workers | [CLI Commands](/reference/cli) |

Only the database layer is always installed. You add the rest when you need them, either when you create the project or later with `npx holo install`. See [Installation](/getting-started/installation).

## Supported platforms

| | Supported |
| --- | --- |
| Frameworks | Next.js 16.3.8+, Nuxt 4.5.1+, SvelteKit 2.70.2+ with Svelte 5.56.8+, within each major version |
| Databases | SQLite, PostgreSQL, MySQL |
| Node.js | 22.12 or newer on the 22 line, 24, or 26 |
| Package managers | npm, pnpm, Yarn, Bun |
| File storage | Local disk, public disk, Amazon S3 and S3-compatible services |
| Queue drivers | Sync, database, Redis |
| Cache drivers | File, memory, database, Redis |

## Where to go next

- **[Quick Start](/getting-started/quick-start)**: create a project and query a model in about ten minutes.
- **[Tutorial](/tutorial/)**: build a complete blog with auth, admin pages, uploads, and realtime updates.
- **[Installation](/getting-started/installation)**: every option for creating a project and adding packages.
- **Your framework**: how Holo fits into [Next.js](/getting-started/frameworks/next), [Nuxt](/getting-started/frameworks/nuxt), or [SvelteKit](/getting-started/frameworks/sveltekit).
