# How Holo Works

You don't need this page to build an app. It explains what happens behind `holo dev` and your imports, for when you're curious, debugging something unusual, or planning to [write a plugin](/advanced/plugins).

## The big picture

Holo sits next to your framework, not on top of it. Next.js, Nuxt, or SvelteKit still handles routing, rendering, and building. Holo adds the backend pieces (database, auth, queues, mail, and so on) and connects them to your framework through a small adapter package.

```text
Your app (routes, pages, server code)
        ↓ uses
Feature packages (@holo-js/db, auth, queue, mail, ...)
        ↓ wired up by
@holo-js/core + a framework adapter (adapter-next, adapter-nuxt, adapter-sveltekit)
        ↓ built on
@holo-js/config and @holo-js/kernel
```

## Packages in layers

Holo is split into many small packages, and dependencies only point downward. A feature package never imports a framework adapter, and a general package never imports a specific driver.

| Layer | Packages | Job |
| --- | --- | --- |
| Base | `@holo-js/kernel` | Project paths, plugin loading, shared contracts. Has no Holo dependencies. |
| Config | `@holo-js/config` | Loads `.env` files and `config/*.ts`, typed `useConfig()`, the config cache. |
| Features | `@holo-js/db`, `auth`, `queue`, `mail`, `cache`, `storage`, `events`, `notifications`, `broadcast`, `security`, `session`, `validation`, `forms`, `media`, `realtime`, `authorization` | The APIs you import in your app. |
| Drivers | `@holo-js/db-sqlite`, `db-postgres`, `db-mysql`, `queue-redis`, `queue-db`, `cache-redis`, `cache-db`, `storage-s3`, `auth-social-*`, `auth-workos`, `auth-clerk` | Concrete backends, installed only when you use them. |
| Wiring | `@holo-js/core` | Starts the services your config asks for, in the right order, and shuts them down cleanly. |
| Framework | `@holo-js/adapter-next`, `adapter-nuxt`, `adapter-sveltekit` | Connects Holo to your framework's startup, requests, cookies, and build. |
| Tools | `@holo-js/cli` | The `holo` command. |

This is why you import `defineQueueConfig` from `@holo-js/queue` but `env` from `@holo-js/config`: each helper lives in the package that owns the feature. See [Packages](/reference/packages) for the full list.

### Config without coupling

`@holo-js/config` doesn't know about queues or mail. Instead, each feature package registers a small function that fills in its defaults when its config module loads. That's how `useConfig('queue')` returns a fully typed object with defaults applied, and why a feature you haven't installed adds no code to your app.

## Discovery and generated files

You never register models, jobs, or commands by hand. Holo finds them by scanning your folders:

| Folder | What Holo looks for |
| --- | --- |
| `server/models` | Models |
| `server/db/migrations`, `server/db/seeders` | Migrations and seeders |
| `server/jobs` | Queue jobs |
| `server/events`, `server/listeners` | Events and listeners |
| `server/broadcast`, `server/channels` | Broadcast events and channel authorization |
| `server/policies`, `server/abilities` | Authorization rules |
| `server/commands` | CLI commands |

The scan writes its results to `.holo-js/generated`: registries that list every file (`models.ts`, `jobs.ts`, `commands.ts`, and so on), TypeScript types that power autocomplete (for example the model registry, config types, and queue job names), and the generated database schema.

Your framework adapter and the CLI read these registries instead of scanning your files again. That keeps startup fast and means every part of Holo agrees on what exists.

The scan runs:

- when `holo dev` starts, and again whenever you change a watched folder, `config/`, or a `.env` file
- at the start of `holo build`
- after each `make:*` generator
- when you run `holo prepare`

::: warning
Holo rewrites `.holo-js/generated` on every scan, and it's in `.gitignore`. Don't edit or commit those files. If something looks stale, run `npx holo prepare`.
:::

The folder paths come from `paths` in `config/app.ts`, so you can move them. See [Configuration Files](/reference/config#paths).

### The generated schema

When you run migrations, Holo records the resulting tables and columns in `.holo-js/generated/schema.generated.ts`. Models read their column types from this file, which is how `Post.where('title', ...)` knows `title` exists without you writing a type.

## What happens when your app starts

1. Your framework boots and loads the Holo adapter (set up for you by `holo new`).
2. The adapter asks `@holo-js/core` to start Holo for the project folder.
3. Core loads `.env` files and `config/*.ts` (or the config cache in production).
4. Core reads the generated registries, then starts each installed service (database connections, queues, mail, cache, sessions, auth, and the rest) and runs the boot code of any active plugins.
5. Your routes run. Model calls, `sendMail()`, `Job.dispatch()`, and so on use the services core started.

If a service fails to start, the ones already started are shut down again in reverse order, so you don't leak connections.

Holo starts once per server process. In development, `holo dev` restarts the dev server when a change needs it (for example a new dependency or a config change).

Your framework can apply the configuration again while the server keeps running, for example during development reloads. Holo keeps using the Redis connections for rate limits and sessions as long as their settings stay the same. If you change one of those settings, operations that are already using the old connection finish on it, and Holo closes it once they do. A store you keep and use outside an operation fails with a closed-connection error after its settings change, so get the store again for each request.

## The CLI runs the same code

`holo migrate`, `holo queue:work`, and your [custom commands](/reference/custom-commands) start Holo the same way your app does: same config, same env files, same registries. That's why a job behaves the same in a worker as it does in a route.

## Framework adapters

Each adapter does only framework-specific work:

- starting Holo when the framework's server starts
- reading requests and writing responses, cookies, and redirects in the framework's own way
- adding Holo's generated files and server-only packages to the framework build

Everything else (validation, auth rules, queries) is shared code in the feature packages, so it behaves the same in all three frameworks.

## Plugins

Plugins use the same mechanism as first-party features. A plugin package declares what it adds (drivers, commands, config, boot code), and Holo loads it from `plugins` in `config/app.ts`. Holo checks that every file path a plugin declares stays inside the plugin's own package before loading any of its code. See [Writing Plugins](/advanced/plugins).

## Next steps

- [Writing Plugins](/advanced/plugins)
- [Project Structure](/getting-started/project-structure)
- [Contributing](/advanced/contributing)
