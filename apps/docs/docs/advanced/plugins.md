# Writing Plugins

A Holo plugin is an npm package that adds features to Holo apps: a queue or mail driver, a notification channel, CLI commands, config files, or code that runs when Holo boots. This page covers using plugins in an app and writing your own.

## Using a plugin

Install and activate a plugin with one command:

```bash
npx holo plugin:add @acme/holo-audit
```

This adds the package to `package.json`, installs any packages the plugin asks for, adds it to `plugins` in `config/app.ts`, and refreshes generated files. If any step fails, your files are put back the way they were.

The activation lives in `config/app.ts`:

```ts [config/app.ts]
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  plugins: ['@acme/holo-audit'],
})
```

Other plugin commands:

| Command | What it does |
| --- | --- |
| `npx holo plugin:list` | List active plugins and whether each one loaded. |
| `npx holo plugin:info <package>` | Show what a plugin adds. |
| `npx holo plugin:doctor` | Load every active plugin and report errors. |
| `npx holo plugin:remove <package>` | Deactivate a plugin. Add `--uninstall` to also remove the package. |

Each also works with a `plugins:` prefix. See [Plugin commands](/reference/cli#plugin-commands).

## Your first plugin

A plugin package needs two things: a `holo.plugin` entry in `package.json`, and a module that exports a plugin definition.

```json [package.json]
{
  "name": "@acme/holo-audit",
  "type": "module",
  "dependencies": {
    "@holo-js/kernel": "^1.0.0"
  },
  "holo": {
    "plugin": "./dist/plugin.mjs"
  }
}
```

```ts [src/plugin.ts]
import { defineHoloPlugin } from '@holo-js/kernel'

export default defineHoloPlugin({
  id: 'acme.audit',
  name: 'Acme Audit',
  description: 'Records an audit log of model changes.',
  contributes: {
    runtime: {
      boot: './dist/runtime/boot.mjs',
    },
  },
})
```

| Field | Description |
| --- | --- |
| `id` | Required. Unique across all active plugins. |
| `name` | Name shown by `plugin:list` and `plugin:info`. |
| `description` | Shown by `plugin:info`. |
| `contributes` | What the plugin adds (see below). |

The entry module can export the definition as `default` or as a named `plugin` export.

::: warning
Every path in a plugin (the `holo.plugin` entry and every module path in `contributes`) must be relative to the plugin package and stay inside it. Absolute paths and paths that leave the package (`../`) are rejected before any plugin code runs.
:::

## What a plugin can add

| `contributes` key | Shape | Effect |
| --- | --- | --- |
| `runtime.boot` | module path | Runs when Holo starts. |
| `cli.commands` | module path | Adds `holo` commands. |
| `queue.drivers` | `{ [name]: { runtime: path } }` | Adds queue drivers. |
| `cache.drivers` | `{ [name]: { runtime: path } }` | Adds cache drivers. |
| `mail.drivers` | `{ [name]: { runtime: path } }` | Adds mail drivers. |
| `broadcast.drivers` | `{ [name]: { runtime: path } }` | Adds broadcast drivers. |
| `notifications.channels` | `{ [name]: { runtime: path } }` | Adds notification channels. |
| `dependencies.holo` | package names | `@holo-js/*` packages that `plugin:add` installs. |
| `dependencies.runtime` | package names | Other npm packages that `plugin:add` installs. |
| `config.files` | file names | Config files the plugin uses (shown by `plugin:info`). |
| `config.env` | variable names | Environment variables the plugin reads (shown by `plugin:info`). |
| `migrations.publish` | module path | Provides migrations for the app. |
| `project.prepare` | module path | Runs during `holo prepare` to generate project files. |

Driver and channel names must be unique across all active plugins.

### Run code at boot

The boot module's default export is a function. Holo calls it once with the project root and the loaded config:

```ts [src/runtime/boot.ts]
import type { LoadedHoloConfig } from '@holo-js/config'

export default async function boot({ projectRoot, config }: {
  projectRoot: string
  config: LoadedHoloConfig
}) {
  console.log(`Audit plugin ready for ${config.app.name} in ${projectRoot}`)
}
```

### Add CLI commands

The commands module exports one command, an array of commands, or `{ commands: [...] }`. Commands use the same `defineCommand()` as [app commands](/reference/custom-commands), but plugin commands must set a `name`:

```ts [src/commands.ts]
import { defineCommand } from '@holo-js/cli'

export const commands = [
  defineCommand({
    name: 'audit:prune',
    description: 'Delete audit entries older than 90 days.',
    async run({ withRuntime }) {
      await withRuntime(async () => {
        console.log('Pruning audit log...')
      })
    },
  }),
]
```

```ts [src/plugin.ts]
export default defineHoloPlugin({
  id: 'acme.audit',
  contributes: {
    cli: {
      commands: './dist/commands.mjs',
    },
  },
})
```

Plugin commands appear under **App commands** in `holo list`.

### Add a queue driver

A queue driver module exports a driver factory whose `driver` matches the name in `contributes`. It can be the default export or a named `factory` export:

```ts [src/plugin.ts]
export default defineHoloPlugin({
  id: 'acme.sqs',
  contributes: {
    dependencies: {
      holo: ['@holo-js/queue'],
    },
    queue: {
      drivers: {
        sqs: { runtime: './dist/queue/sqs.mjs' },
      },
    },
  },
})
```

Apps then use it as `driver: 'sqs'` in `config/queue.ts`. Look at the `@holo-js/queue-redis` package for a complete driver factory.

## Give your plugin its own config file

A plugin can add a typed config file, such as `config/audit.ts`. Register a normalizer that fills in defaults, and add your config to `HoloConfigRegistry` so `useConfig('audit')` is typed:

```ts [src/config.ts]
import { registerConfigNormalizer } from '@holo-js/config'

export interface AuditConfig {
  table?: string
}

export interface NormalizedAuditConfig {
  readonly table: string
}

export function defineAuditConfig<TConfig extends AuditConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    audit: NormalizedAuditConfig
  }
}

registerConfigNormalizer<AuditConfig, NormalizedAuditConfig>({
  name: 'audit',
  normalize(config) {
    return Object.freeze({
      table: config?.table?.trim() || 'audit_log',
    })
  },
})
```

Apps then write:

```ts [config/audit.ts]
import { defineAuditConfig } from '@acme/holo-audit'

export default defineAuditConfig({
  table: 'application_audit_log',
})
```

List the file in `contributes.config.files` so `plugin:info` shows it.

## Test your plugin

1. Make the package available to a test app (for example with a workspace link or `npm install ../holo-audit`), then run `npx holo plugin:add @acme/holo-audit`.
2. Run `npx holo plugin:doctor` to check that it loads.
3. Run `npx holo plugin:info <package>` to see what Holo found.

After changing a plugin, run `npx holo prepare` so the app's generated files match.

## Ship models and jobs in a package

A package that ships Holo models, jobs, or plugins must list `@holo-js/*` packages as `peerDependencies`, not `dependencies`. The app then installs one copy of each Holo package, and your package uses that copy.

```json
{
  "peerDependencies": {
    "@holo-js/db": "*",
    "@holo-js/queue": "*"
  }
}
```

If an install nests a separate copy of a `@holo-js/*` package inside your package, models and jobs from it do not share the app's Holo copy. Declare the peers so the package manager resolves one copy.

## Next steps

- [How Holo Works](/advanced/architecture)
- [Custom Commands](/reference/custom-commands)
- [CLI Commands](/reference/cli#plugin-commands)
