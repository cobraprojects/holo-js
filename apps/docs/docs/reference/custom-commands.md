# Custom Commands

You can add your own `holo` commands for one-off scripts and maintenance tasks: backfilling data, sending a report, cleaning up old files. Put a file in `server/commands` and Holo picks it up automatically.

## Your first command

```ts [server/commands/posts/publish-scheduled.ts]
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  description: 'Publish posts whose publish date has passed.',
  async run() {
    console.log('Publishing scheduled posts...')
  },
})
```

Run it:

```bash
npx holo posts:publish-scheduled
```

It also shows up under **App commands** in `npx holo list`.

## Command names

When you don't set a `name`, Holo builds one from the file path inside `server/commands`. Folders become `:` segments and the file extension is dropped:

| File | Command |
| --- | --- |
| `server/commands/report.ts` | `holo report` |
| `server/commands/posts/publish-scheduled.ts` | `holo posts:publish-scheduled` |
| `server/commands/users/cleanup/inactive.ts` | `holo users:cleanup:inactive` |

Set `name` to choose your own, and `aliases` for extra names:

```ts [server/commands/report.ts]
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  name: 'reports:daily',
  aliases: ['report'],
  description: 'Send the daily sales report.',
  usage: 'holo reports:daily [--date YYYY-MM-DD]',
  async run() {
    console.log('Sending report...')
  },
})
```

Command names and aliases must be unique. If one clashes with a built-in command like `list` or `migrate`, `holo` stops with an error that names both commands.

Holo discovers `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs` files. The command can be the default export or a named export.

Holo loads every command file to read its name and description. If a command file fails to load, for example because a module it imports is missing, the other commands still work. `holo list` shows the failed command under its file path name with `Failed to load:` and the error, and running it prints the same error. If another command already uses that name, `holo` leaves the failed command out. Once the file loads again, its custom `name` and `aliases` work again.

## Arguments and flags

`run` receives a context object. Positional arguments are in `context.args` and flags are in `context.flags`:

```ts [server/commands/users/promote.ts]
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  description: 'Give a user a role.',
  usage: 'holo users:promote <email> [--role <role>] [--dry-run]',
  async run({ args, flags }) {
    const email = args[0]
    if (!email) {
      throw new Error('Pass the user email: holo users:promote <email>')
    }

    const role = typeof flags.role === 'string' ? flags.role : 'admin'
    const dryRun = flags['dry-run'] === true

    console.log(`${dryRun ? '[dry run] ' : ''}Promoting ${email} to ${role}`)
  },
})
```

```bash
npx holo users:promote ada@example.com --role editor --dry-run
```

Flags follow the same rules as built-in commands (see [How arguments and flags work](/reference/cli#how-arguments-and-flags-work)):

| You type | `flags` value |
| --- | --- |
| `--role editor` or `--role=editor` | `'editor'` |
| `--dry-run` | `true` |
| `-v` | `{ v: true }` |
| `--tag a --tag b` | `['a', 'b']` |

Flag values are always strings or `true`. Convert numbers yourself, for example `Number(flags.limit)`.

## Output and errors

Write output with `console.log` and `console.error`.

To fail a command, throw an error. Holo prints the error message and exits with code `1`. When `run` finishes normally, the exit code is `0`.

```ts
if (!email) {
  throw new Error('Missing email.')
}
```

## Using the database and other services

Commands don't connect to your database or start other services until you ask. Wrap the work in `context.withRuntime()`. Inside the callback, Holo has loaded your config and connected services, so models, `DB`, mail, queues, and storage work as they do in your routes.

```ts [server/commands/posts/publish-scheduled.ts]
import { defineCommand } from '@holo-js/cli'
import Post from '../../models/Post'

export default defineCommand({
  description: 'Publish posts whose publish date has passed.',
  async run({ withRuntime }) {
    const count = await withRuntime(async () => {
      return await Post.where('status', 'scheduled').count()
    })

    console.log(`${count} scheduled posts found.`)
  },
})
```

When the callback finishes (or throws), Holo shuts the services down and closes the connections. The callback's return value is returned from `withRuntime()` with its type.

You can call `withRuntime()` more than once. Nested calls reuse the same connections.

A command can import the same app modules as your routes, including modules that import framework packages. For example, a service that imports `next/headers` loads in a command too.

### The runtime object

The callback receives a runtime object with two members:

| Member | Description |
| --- | --- |
| `holo` | The Holo runtime. Use `holo.useConfig('app')` or `holo.config('app.name')` to read config, and `holo.projectRoot` for the project path. |
| `migrate({ names, pretend })` | Run specific migrations by name. Returns the names that ran. With `pretend: true`, returns the names that would run without running them. |

```ts [server/commands/app-info.ts]
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  description: 'Print the app name and environment.',
  async run({ withRuntime }) {
    const app = await withRuntime(({ holo }) => holo.useConfig('app'))

    console.log(`${app.name} (${app.env})`)
  },
})
```

## The context object

| Property | Description |
| --- | --- |
| `args` | Positional arguments, as strings. |
| `flags` | Parsed flags. |
| `cwd` | The folder you ran `holo` from. |
| `projectRoot` | Your project's root folder. |
| `withRuntime(callback)` | Start Holo services, run the callback, then shut them down. |
| `loadProject()` | Load the Holo project settings, such as the configured folder paths. |

## Definition options

| Option | Required | Description |
| --- | --- | --- |
| `description` | Yes | One line shown in `holo list` and `--help`. |
| `run(context)` | Yes | The function to run. Can be async. |
| `name` | No | Command name. Defaults to the name built from the file path. |
| `aliases` | No | Extra names for the command. |
| `usage` | No | Usage line shown by `holo <command> --help`. Defaults to `holo <name>`. |

## Changing the commands folder

Commands live in `server/commands` by default. To use another folder, set `paths.commands` in `config/app.ts`. See [Configuration Files](/reference/config).

## Available functions

**Defining a command**

- [defineCommand()](#definecommand)

**Context**

- [args and flags](#args-and-flags-context)
- [cwd and projectRoot](#cwd-and-projectroot)
- [loadProject()](#loadproject)
- [withRuntime()](#withruntime)

**Runtime object**

- [holo](#holo)
- [migrate()](#migrate)

### defineCommand() {#definecommand}

Declares a command. Export it as the default export of a file in `server/commands`. It accepts the [definition options](#definition-options) and returns the same object, frozen.

```ts [server/commands/report.ts]
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  description: 'Send the daily sales report.',
  async run() {
    console.log('Sending report...')
  },
})
```

### args and flags {#args-and-flags-context}

`args` holds the positional arguments as strings. `flags` holds the parsed flags. See [arguments and flags](#arguments-and-flags).

```ts
const email = args[0]
const dryRun = flags['dry-run'] === true
```

### cwd and projectRoot {#cwd-and-projectroot}

`cwd` is the folder you ran `holo` from. `projectRoot` is your project's root folder.

```ts
console.log(projectRoot, cwd)
```

### loadProject() {#loadproject}

Returns the project settings, including the folder paths in `config.paths`. Use it when a command needs to find files such as models or migrations.

```ts
const { config } = await loadProject()
console.log(config.paths.commands)
```

### withRuntime() {#withruntime}

Starts Holo services, runs your callback, and shuts the services down afterwards. It returns the callback's result. See [using the database and other services](#using-the-database-and-other-services).

```ts
const count = await withRuntime(() => Post.where('status', 'scheduled').count())
```

### holo {#holo}

The Holo runtime, passed to the `withRuntime()` callback. Use `holo.useConfig()` or `holo.config()` to read config, and `holo.projectRoot` for the project path.

```ts
await withRuntime(({ holo }) => holo.config('app.name'))
```

### migrate() {#migrate}

Runs the named migrations and returns their names. With `pretend: true`, it returns the names that would run without running them. Pass the names of the migrations to run, such as `create_posts_table`.

```ts
await withRuntime(({ migrate }) => migrate({ names: ['create_posts_table'], pretend: true }))
```

## Next steps

- [CLI Commands](/reference/cli)
- [Using Holo Services](/basics/services)
- [Seeding](/database/seeding) — for repeatable test and demo data
