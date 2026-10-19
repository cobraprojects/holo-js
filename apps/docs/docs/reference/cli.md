# CLI Commands

The `holo` command line tool creates projects, generates files, runs migrations, starts workers, and runs your own app commands. This page lists every built-in command with its arguments and flags.

## Running holo

`holo` ships with the `@holo-js/cli` package, which every Holo project installs. Run it through your package manager from the project folder:

::: code-group

```bash [npm]
npx holo list
```

```bash [pnpm]
pnpm dlx holo list
```

```bash [Yarn]
yarn dlx holo list
```

```bash [Bun]
bunx holo list
```

:::

The rest of the docs write every command with `npx`. Swap in your package manager's runner if you use a different one.

You can also run `holo` without a command, or with `help`, `--help`, or `-h`, to print the command list.

### List all commands

```bash
npx holo list
```

The output has two sections: **Internal commands** (built into Holo) and **App commands** (the ones you write in `server/commands`, plus any commands from plugins). See [Custom Commands](/reference/custom-commands).

### Help for one command

Add `--help` or `-h` to any command to print its usage line and description:

```bash
npx holo make:model --help
```

### Print the version

```bash
npx holo --version
```

`-v` works too.

## How arguments and flags work

These rules apply to every command, including your own app commands.

| Form | Meaning |
| --- | --- |
| `--name value` or `--name=value` | A flag with a value. |
| `--name` | A boolean flag (`true`). |
| `-m` | A short flag. `-mfs` sets `-m`, `-f`, and `-s` together. |
| `--queue a --queue b` | Repeating a flag collects every value. |
| `--queue a,b` | Most list flags also accept comma-separated values. |
| `--` | Everything after `--` is passed as plain arguments. |

Number flags such as `--step` and `--tries` must be non-negative whole numbers.

### Pick the environment

Every command accepts `--env` to pick the environment for that run. It wins over `APP_ENV` from your shell or `.env`, and decides which `.env` files load. See [Env files and loading order](/reference/environment#env-files-and-loading-order).

```bash
npx holo migrate:fresh --env=test
```

### Interactive prompts

When you run a command in a terminal and leave out a required argument, `holo` asks for it. Some commands, like `new`, `install`, and `make:model`, also ask follow-up questions.

Turn prompts off with `--no-interactive`:

```bash
npx holo make:model Post --no-interactive
```

Prompts are also skipped automatically when the command doesn't run in a terminal (for example in CI). In that case, a missing required argument makes the command fail.

## Project commands

### new

Create a new Holo project in a new folder and install its dependencies.

```bash
npx holo new <name> [options]
```

| Argument / flag | Description |
| --- | --- |
| `<name>` | Project folder name. You can pass `--name <name>` instead. The folder must be empty or not exist. |
| `--framework <nuxt\|next\|sveltekit>` | Framework to scaffold. Default: `nuxt`. |
| `--database <sqlite\|mysql\|postgres>` | Database driver. Default: `sqlite`. |
| `--package-manager <npm\|pnpm\|yarn\|bun>` | Package manager used to install dependencies. Default: `npm`. |
| `--package <name>` | Optional package to include. Repeat the flag or pass a comma-separated list. Values: `storage`, `events`, `queue`, `validation`, `forms`, `auth`, `authorization`, `notifications`, `mail`, `broadcast`, `realtime`, `security`, `cache`, or `none`. Choosing `forms` also adds `validation`. |
| `--storage-default-disk <local\|public>` | Default disk when `storage` is included. Default: `local`. |

```bash
npx holo new blog --framework next --database postgres --package auth,mail,queue
```

::: tip
Most people start with `create holo-js` instead. See [Installation](/getting-started/installation).
:::

### dev

Refresh Holo's generated files, then start your framework's dev server.

```bash
npx holo dev [...frameworkArgs]
```

While it runs, `holo dev` watches your Holo folders (`config/`, `.env` files, `server/models`, `server/jobs`, and so on) and refreshes the generated files when they change, restarting the dev server when needed.

| Argument / flag | Description |
| --- | --- |
| `...frameworkArgs` | Any extra arguments and flags are passed to the framework's dev server. |

If you don't pass `--port` (or `-p`), Holo uses the `PORT` environment variable when it's set.

```bash
npx holo dev --port 4000
```

Your scaffolded `package.json` already has `"dev": "holo dev"`, so `npm run dev` does the same thing.

### build

Refresh Holo's generated files, then run your framework's production build.

```bash
npx holo build [...frameworkArgs]
```

| Argument / flag | Description |
| --- | --- |
| `...frameworkArgs` | Extra arguments passed to the framework build. |

```bash
npx holo build
```

### start

Start the production server from a finished build.

```bash
npx holo start [...frameworkArgs]
```

| Argument / flag | Description |
| --- | --- |
| `...frameworkArgs` | Extra arguments passed to the production server. |

Like `dev`, `start` uses `PORT` when you don't pass `--port`. It loads your `.env` files and runs the server with `NODE_ENV=production`. The application environment still comes from `APP_ENV`, which is `production` when it isn't set. See [Deployment](/deployment/).

```bash
PORT=8080 npx holo start
```

### prepare

Scan your project and regenerate the files in `.holo-js/generated` (model, migration, job, event, and command registries, plus generated types).

```bash
npx holo prepare
```

`dev` and `build` run this for you. Run it yourself after pulling changes or when your editor's types look out of date.

### install

Add a first-party Holo feature to an existing project. It adds the package, creates config files and folders, updates `.env` and `.env.example`, then installs dependencies.

```bash
npx holo install <target> [options]
```

| Argument / flag | Description |
| --- | --- |
| `<target>` | One of `queue`, `events`, `auth`, `authorization`, `notifications`, `mail`, `broadcast`, `realtime`, `security`, `cache`, `media`. |
| `--driver <name>` | Only for `queue` (`sync`, `redis`, `database`; default `sync`) and `cache` (`file`, `redis`, `database`; default `file`). Other targets reject this flag. |
| `--social` | `auth` only. Add social login support. |
| `--provider <name>` | `auth` only. Social provider to add: `google`, `github`, `discord`, `facebook`, `apple`, `linkedin`. Repeat or comma-separate. Implies `--social`. |
| `--workos` | `auth` only. Add WorkOS support. |
| `--clerk` | `auth` only. Add Clerk support. |

What each target creates:

| Target | Creates |
| --- | --- |
| `queue` | `config/queue.ts`, `server/jobs` |
| `events` | `server/events`, `server/listeners`. Offers to set up queued listeners if queues aren't installed. |
| `auth` | `config/auth.ts`, `config/session.ts`, `config/security.ts`, `config/cors.ts`, `server/models/User.ts` |
| `authorization` | `server/policies`, `server/abilities` |
| `notifications` | `config/notifications.ts` |
| `mail` | `config/mail.ts`, `server/mail` |
| `broadcast` | `config/broadcast.ts`, `server/broadcast`, `server/channels`, the `/broadcasting/auth` route, and client setup |
| `realtime` | `server/realtime` and framework setup |
| `security` | `config/security.ts`, `config/cors.ts` |
| `cache` | `config/cache.ts` (and `config/redis.ts` for Redis) |
| `media` | `config/media.ts` and the media table migration |

```bash
npx holo install queue --driver redis
npx holo install auth --provider google,github
```

### key:generate

Write a random `APP_KEY` to your project's `.env` file. If `.env` doesn't exist, it is created. If `APP_KEY` already has a value, nothing changes.

```bash
npx holo key:generate
```

### config:cache

Compile every file in `config/` (with your env values applied) into one cached file at `.holo-js/generated/config-cache.json`. When the app runs in production (`APP_ENV=production`) and the cache was built for production, Holo reads it instead of loading `config/*.ts`. Other environments ignore the cache.

```bash
APP_ENV=production npx holo config:cache
```

::: warning
In production, changes to `config/*.ts` or `.env` have no effect after you cache config until you run `config:cache` again or `config:clear`. Rebuild the cache on every deploy.
:::

### config:clear

Delete the config cache so Holo loads `config/*.ts` again.

```bash
npx holo config:clear
```

### agents:install

Install Holo-JS skill files for AI coding agents so they can look up Holo docs while they work. See [Coding with AI Agents](/getting-started/ai-agents).

```bash
npx holo agents:install [options]
```

Aliases: `agent:install`, `ai:install`.

| Flag | Description |
| --- | --- |
| `--agent <name>` | Agents to install for: `all`, `codex`, `claude`, `cursor`, `windsurf`, `opencode`, `gemini`, `kiro`. Repeat or comma-separate. In a terminal you get a picker; otherwise every agent is installed. |
| `--global` | Install into your home folder instead of the current project. |
| `--force` | Replace skill folders that you changed by hand. Without it, the command refuses to overwrite them. |

```bash
npx holo agents:install --agent claude,cursor
```

### auth:notifications:publish

Copy the built-in auth notifications (such as email verification and password reset) into your app so you can edit them. Existing files are skipped.

```bash
npx holo auth:notifications:publish
```

## Generators

Generators create a file from a template and then refresh the generated registries. Names can include folders, such as `reports/send-digest`. A generator fails if the file or name already exists.

### make:model

Create a [model](/orm/), and optionally its migration, observer, seeder, and factory.

```bash
npx holo make:model <name> [options]
```

| Argument / flag | Description |
| --- | --- |
| `<name>` | Model name, such as `Post` or `blog/Post`. |
| `--table <table>` | Table name to use instead of the default. |
| `-m`, `--migration` | Also create a migration. |
| `-o`, `--observer` | Also create an observer and attach it to the model. |
| `-s`, `--seeder` | Also create a seeder. |
| `-f`, `--factory` | Also create a factory. |

In a terminal, if you pass none of `-m`, `-o`, `-s`, `-f`, you're asked which files to create.

```bash
npx holo make:model Post -mfs
```

Creates `server/models/Post.ts`, plus files in `server/db/migrations`, `server/db/factories`, and `server/db/seeders`.

### make:migration

Create a timestamped [migration](/database/migrations) in `server/db/migrations`.

```bash
npx holo make:migration <name> [--create <table> | --table <table>]
```

| Argument / flag | Description |
| --- | --- |
| `<name>` | Migration name, such as `create_posts_table`. |
| `--create <table>` | Scaffold a migration that creates this table. |
| `--table <table>` | Scaffold a migration that changes this existing table. |

Use one of `--create` or `--table`, not both. Without either, Holo guesses from names like `create_posts_table` or `add_status_to_posts_table`.

```bash
npx holo make:migration add_status_to_posts_table --table posts
```

### make:seeder

Create a [seeder](/database/seeding) in `server/db/seeders`.

```bash
npx holo make:seeder <name>
```

```bash
npx holo make:seeder UserSeeder
```

### make:factory

Create a [factory](/orm/factories) in `server/db/factories`.

```bash
npx holo make:factory <name>
```

```bash
npx holo make:factory PostFactory
```

### make:observer

Create a model [observer](/orm/observers) in `server/db/observers`. It doesn't attach the observer to an existing model; use `make:model --observer` for that.

```bash
npx holo make:observer <name>
```

```bash
npx holo make:observer PostObserver
```

### make:job

Create a [queue job](/queue/jobs) in `server/jobs`. File names are converted to kebab-case, and the job name uses dots for folders.

```bash
npx holo make:job <name>
```

```bash
npx holo make:job reports/send-digest
```

Creates `server/jobs/reports/send-digest.ts` with the job name `reports.send-digest`.

### make:event

Create an [event](/events/defining-events) in `server/events`.

```bash
npx holo make:event <name>
```

```bash
npx holo make:event user/registered
```

Creates `server/events/user/registered.ts` with the event name `user.registered`.

### make:listener

Create an event [listener](/events/listeners) in `server/listeners`.

```bash
npx holo make:listener <name> --event <event-name>
```

| Argument / flag | Description |
| --- | --- |
| `<name>` | Listener name. |
| `--event <event-name>` | Required. The event to listen to. Repeat or comma-separate to listen to several events. |

```bash
npx holo make:listener user/send-welcome-email --event user.registered
```

### make:mail

Create a [mail definition](/mail/writing-mail) in `server/mail`. Mail files are created as Markdown mail.

```bash
npx holo make:mail <name> [--markdown]
```

| Argument / flag | Description |
| --- | --- |
| `<name>` | Mail name, such as `auth/verify-email`. |
| `--markdown` | Create a Markdown mail. This is already the default. |

```bash
npx holo make:mail orders/order-shipped
```

### make:broadcast

Create a [broadcast event](/broadcasting/events-and-channels) in `server/broadcast`.

```bash
npx holo make:broadcast <name>
```

```bash
npx holo make:broadcast orders/shipment-updated
```

### make:channel

Create a [channel authorization](/broadcasting/events-and-channels) file in `server/channels`.

```bash
npx holo make:channel <pattern>
```

| Argument | Description |
| --- | --- |
| `<pattern>` | Channel name pattern. Use `{param}` for dynamic parts. |

```bash
npx holo make:channel orders.{orderId}
```

## Database commands

### migrate

Run every [migration](/database/migrations) that hasn't run yet.

```bash
npx holo migrate [--step <n>] [--isolated]
```

| Flag | Description |
| --- | --- |
| `--step <n>` | Run at most this many pending migrations. |
| `--isolated` | Take a database lock first. If another run holds it, this run skips and exits successfully. Use it when several replicas run `migrate` at deploy time. See [Isolating migration runs](/database/migrations#isolating-migration-runs). |

```bash
npx holo migrate
```

### migrate:fresh

Drop every table on the default connection and run all migrations from scratch.

```bash
npx holo migrate:fresh [--seed] [--only <names>] [--quietly] [--force]
```

| Flag | Description |
| --- | --- |
| `--seed` | Run seeders after migrating. |
| `--only <names>` | With `--seed`, run only these seeders (comma-separated). |
| `--quietly` | With `--seed`, run seeders without firing model events. |
| `--force` | Skip the production confirmation. |

```bash
npx holo migrate:fresh --seed
```

When `APP_ENV` is `production`, `migrate:fresh` asks you to confirm before it drops anything. Without a terminal, it stops with an error unless you pass `--force`.

::: danger
`migrate:fresh` deletes all your data. Never run it against a production database.
:::

### migrate:rollback

Undo migrations.

```bash
npx holo migrate:rollback [--step <n>] [--batch <n>] [--force]
```

| Flag | Description |
| --- | --- |
| `--step <n>` | Roll back at most this many migrations from the batch. |
| `--batch <n>` | Roll back this batch number instead of the latest one. |
| `--force` | Skip the production confirmation. |

With no flags, every migration in the latest batch is rolled back. When `APP_ENV` is `production`, the command asks you to confirm first, and without a terminal it stops with an error unless you pass `--force`.

```bash
npx holo migrate:rollback --step 1
```

### seed

Run your [seeders](/database/seeding).

```bash
npx holo seed [--only <names>] [--quietly] [--force]
```

| Flag | Description |
| --- | --- |
| `--only <names>` | Run only these seeders. Comma-separate or repeat the flag. |
| `--quietly` | Run seeders without firing model events (observers don't run). |
| `--force` | Skip the production confirmation. |

```bash
npx holo seed --only roles,admin
```

When `APP_ENV` is `production`, `seed` asks you to confirm first. Without a terminal, it stops with an error unless you pass `--force`.

### prune

Delete old records from models that define a `prunable` query.

```bash
npx holo prune [ModelName ...]
```

| Argument | Description |
| --- | --- |
| `ModelName ...` | Prune only these models. Without names, every prunable model is pruned. Naming an unknown or non-prunable model is an error. |

```bash
npx holo prune Session AuditLog
```

## Queue commands

See [Running Workers](/queue/workers) and [Failed Jobs](/queue/failed-jobs) for the full workflow.

### queue:work

Process jobs from an async queue connection (`redis` or `database`). The `sync` driver doesn't need a worker.

```bash
npx holo queue:work [options]
```

| Flag | Description |
| --- | --- |
| `-c`, `--connection <name>` | Queue connection from `config/queue.ts`. Default: the default connection. |
| `-q`, `--queue <name>` | Queue names to process. Repeat or comma-separate. |
| `--once` | Process one job and stop. |
| `--stop-when-empty` | Stop when the queue has no more jobs. |
| `--sleep <seconds>` | Seconds to wait when the queue is empty. Default: the connection's `sleep` setting, or `1`. |
| `--tries <n>` | Maximum attempts per job, overriding the job's setting. |
| `--timeout <seconds>` | Maximum run time per job, overriding the job's setting. |
| `--max-jobs <n>` | Stop after processing this many jobs. |
| `--max-time <seconds>` | Stop after running this long. |

The worker stops cleanly on `SIGINT` / `SIGTERM` and when [`queue:restart`](#queue-restart) is run.

```bash
npx holo queue:work --connection redis --queue emails,media --tries 3
```

### queue:listen

Run a queue worker for development. It restarts the worker whenever your jobs, config, or related files change.

```bash
npx holo queue:listen [options]
```

Accepts the same flags as `queue:work` except `--once` and `--stop-when-empty`.

```bash
npx holo queue:listen --connection redis --queue media
```

### queue:restart

Tell every running worker to stop after its current job. Your process manager (systemd, PM2, Docker, and so on) then starts fresh workers with your new code. `queue:listen` restarts its worker automatically.

```bash
npx holo queue:restart
```

### queue:clear

Delete pending jobs from a connection.

```bash
npx holo queue:clear [--connection <name>] [--queue <name>]
```

| Flag | Description |
| --- | --- |
| `-c`, `--connection <name>` | Connection to clear. Default: the default connection. |
| `-q`, `--queue <name>` | Only clear these queues. Repeat or comma-separate. |

```bash
npx holo queue:clear --connection redis --queue emails
```

### queue:failed

List failed jobs.

```bash
npx holo queue:failed
```

### queue:retry

Push failed jobs back onto their queue.

```bash
npx holo queue:retry <id|all>
```

| Argument | Description |
| --- | --- |
| `<id\|all>` | A failed job ID from `queue:failed`, or `all`. |

```bash
npx holo queue:retry all
```

### queue:forget

Delete one failed job record.

```bash
npx holo queue:forget <id>
```

### queue:flush

Delete every failed job record.

```bash
npx holo queue:flush
```

### queue:table

Create the migration for the `database` queue driver's jobs table.

```bash
npx holo queue:table
```

### queue:failed-table

Create the migration for the failed jobs table.

```bash
npx holo queue:failed-table
```

## Cache commands

### cache:clear

Remove every item from a [cache](/cache/) store.

```bash
npx holo cache:clear [--driver <name>]
```

| Flag | Description |
| --- | --- |
| `-d`, `--driver <name>` | Store name from `config/cache.ts`. Default: the default store. |

```bash
npx holo cache:clear --driver redis
```

### cache:forget

Remove one key from a cache store.

```bash
npx holo cache:forget <key> [--driver <name>]
```

| Argument / flag | Description |
| --- | --- |
| `<key>` | The cache key to remove. |
| `-d`, `--driver <name>` | Store name. Default: the default store. |

```bash
npx holo cache:forget dashboard.stats
```

### cache:table

Create the migration for the `database` cache driver's tables (cache entries and locks).

```bash
npx holo cache:table
```

## Security commands

### rate-limit:clear

Clear [rate limit](/basics/security/rate-limiting) counters. Works with the `file` and `redis` drivers. The `memory` driver lives inside your server process, so it can't be cleared from the CLI.

```bash
npx holo rate-limit:clear [--limiter <name>] [--key <value>] [--all]
```

| Flag | Description |
| --- | --- |
| `--limiter <name>` | The limiter to clear. Required unless you pass `--all`. |
| `--key <value>` | Only clear this key within the limiter, such as `user:42`. |
| `--all` | Clear every limiter. |

```bash
npx holo rate-limit:clear --limiter login --key "ip:203.0.113.7"
```

## Media commands

### media:table

Create the migration for the media table. `holo install media` already does this, so you only need it when you add `@holo-js/media` by hand.

```bash
npx holo media:table
```

### media:regenerate

Rebuild [image conversions](/media/conversions) for stored media.

```bash
npx holo media:regenerate [ModelName ...] [--ids=<ids>] [--only=<names>] [--only-missing]
```

| Argument / flag | Description |
| --- | --- |
| `ModelName ...` | Only regenerate media attached to these models. |
| `--ids=<ids>` | Only these media IDs (positive integers, comma-separated). |
| `--only=<names>` | Only these conversions, such as `thumb`. Comma-separated. |
| `--only-missing` | Only create conversions that don't exist yet. |

```bash
npx holo media:regenerate Post --only=thumb
```

## Broadcast commands

### broadcast:work

Start the self-hosted [broadcast](/broadcasting/) WebSocket server. It reads `config/broadcast.ts` and your channel files, and prints the host and port it listens on. Stop it with `Ctrl+C` or `SIGTERM`.

```bash
npx holo broadcast:work
```

See [Scaling in Production](/broadcasting/production) for running it alongside your app.

## Plugin commands

Plugins are npm packages that add drivers, config, or commands to Holo. See [Writing Plugins](/advanced/plugins).

Every `plugin:*` command also works with a `plugins:` prefix (for example `plugins:add`).

### plugin:add

Install a plugin package, add any packages it needs, activate it in `config/app.ts`, and refresh generated files. If any step fails, your `package.json`, `config/app.ts`, and `.holo-js` folder are restored.

```bash
npx holo plugin:add <package>
```

```bash
npx holo plugin:add @acme/holo-plugin-sentry
```

### plugin:remove

Deactivate a plugin in `config/app.ts`.

```bash
npx holo plugin:remove <package> [--uninstall]
```

| Argument / flag | Description |
| --- | --- |
| `<package>` | Plugin package name. |
| `--uninstall` | Also remove the package from `package.json` and reinstall dependencies. |

```bash
npx holo plugin:remove @acme/holo-plugin-sentry --uninstall
```

### plugin:list

List active plugins and whether each one loaded.

```bash
npx holo plugin:list
```

### plugin:info

Show a plugin's name, description, and what it adds (drivers, config files, env keys, commands, and so on).

```bash
npx holo plugin:info <package>
```

### plugin:doctor

Load every active plugin and report problems. Exits with an error if any plugin fails.

```bash
npx holo plugin:doctor
```

## Next steps

- [Custom Commands](/reference/custom-commands) — add your own `holo` commands
- [Configuration Files](/reference/config)
- [Environment Variables](/reference/environment)
- [Deploying Holo Apps](/deployment/)
