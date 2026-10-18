# Installation

This page covers every way to create a Holo-JS project, add packages later, and run the `holo` CLI. For the fastest path, see the [Quick Start](/getting-started/quick-start).

## Requirements

- **Node.js** 22.12 or newer on the 22 line, or Node.js 24 or 26
- **A package manager**: npm, pnpm, Yarn, or Bun
- **A database**: SQLite (no server needed), PostgreSQL, or MySQL
- **A framework**: Next.js 16.3.8 or newer on the 16 line, Nuxt 4.5.1 or newer on the 4 line, or SvelteKit 2.70.2 or newer on the 2 line with Svelte 5.56.8 or newer on the 5 line

You don't need an existing framework app. The installer creates the Next.js, Nuxt, or SvelteKit project for you.

Holo adapters use your app's framework instead of installing their own copy. `@holo-js/adapter-next` needs `next` and `react`, `@holo-js/adapter-nuxt` needs `nuxt` and `vue`, and `@holo-js/adapter-sveltekit` needs `@sveltejs/kit` and `svelte`. Keep these packages in your app's `package.json`. Projects created by the installer already list them.

## Create a project

Run the installer and answer the prompts:

::: code-group

```bash [npm]
npm create holo-js@latest my-app
```

```bash [pnpm]
pnpm create holo-js my-app
```

```bash [Yarn]
yarn create holo-js my-app
```

```bash [Bun]
bun create holo-js my-app
```

:::

The installer asks for:

| Prompt | Choices | Default |
| --- | --- | --- |
| Project name | any folder name (skipped if you passed one) | — |
| Framework | `nuxt`, `next`, `sveltekit` | `nuxt` |
| Database driver | `sqlite`, `mysql`, `postgres` | `sqlite` |
| Package manager | `npm`, `pnpm`, `yarn`, `bun` | `npm` |
| Optional packages | any of the [optional packages](#optional-packages), or none | none |
| Default storage disk | `local`, `public` (only asked when you pick `storage`) | `local` |

The installer then writes the project files, installs dependencies with the package manager you chose, and prints the command to start the dev server. The target folder must be empty or not exist yet.

::: tip
The installer does not detect which package manager launched it. Choose the same one in the prompt so your lockfile and scripts match.
:::

## Create a project without prompts

Pass flags to skip the prompts. This is useful in CI, templates, and scripts. With npm, put `--` before the flags so npm passes them through.

::: code-group

```bash [npm]
npm create holo-js@latest my-app -- \
  --framework next \
  --database postgres \
  --package-manager npm \
  --package auth,forms,mail
```

```bash [pnpm]
pnpm create holo-js my-app \
  --framework next \
  --database postgres \
  --package-manager pnpm \
  --package auth,forms,mail
```

```bash [Yarn]
yarn create holo-js my-app \
  --framework next \
  --database postgres \
  --package-manager yarn \
  --package auth,forms,mail
```

```bash [Bun]
bun create holo-js my-app \
  --framework next \
  --database postgres \
  --package-manager bun \
  --package auth,forms,mail
```

:::

| Flag | Values | Default |
| --- | --- | --- |
| `<name>` or `--name <name>` | the project folder | required |
| `--framework` | `nuxt`, `next`, `sveltekit` | `nuxt` |
| `--database` | `sqlite`, `mysql`, `postgres` | `sqlite` |
| `--package-manager` | `npm`, `pnpm`, `yarn`, `bun` | `npm` |
| `--package` | comma-separated optional packages; repeat the flag to add more | none |
| `--storage-default-disk` | `local`, `public` (used only with `--package storage`) | `local` |
| `--no-interactive` | never prompt; use defaults for anything not passed | off |

Prompts are also skipped automatically when the terminal is not interactive, such as in CI. In that case, any flag you leave out uses its default.

## Optional packages

The database layer is always installed. Add these packages when your app needs them:

| Name | What you get |
| --- | --- |
| `validation` | Schemas and rules for validating input. See [Validation](/basics/validation/). |
| `forms` | Form submission helpers for each framework. Also adds `validation`. See [Forms](/basics/forms/). |
| `security` | CSRF protection, rate limiting, and CORS config. See [Security](/basics/security/). |
| `auth` | Login, sessions, and a `User` model with migrations. Also adds security and session support. See [Authentication](/auth/). |
| `authorization` | Policies and abilities in `server/policies` and `server/abilities`. See [Authorization](/authorization/). |
| `queue` | Background jobs in `server/jobs`, using the `sync` driver to start. See [Queues](/queue/). |
| `events` | Events and listeners in `server/events` and `server/listeners`. Also adds the queue package. See [Events](/events/). |
| `mail` | Mail definitions in `server/mail` and `config/mail.ts`. See [Mail](/mail/). |
| `notifications` | Notifications config and a notifications table migration. See [Notifications](/notifications/). |
| `cache` | A cache store using the `file` driver to start. See [Cache](/cache/). |
| `storage` | File disks (`local`, `public`, `s3`) in `config/storage.ts`. See [File Storage](/storage/). |
| `broadcast` | WebSocket broadcasting config and the browser client. See [Broadcasting](/broadcasting/). |
| `realtime` | Live-updating queries in `server/realtime`. Also installs the broadcast packages it builds on. See [Realtime Queries](/realtime/). |

## Add packages to an existing project

Use `holo install` to add a feature later. It updates `package.json`, writes the config files and folders, installs dependencies, and refreshes generated files.

```bash
npx holo install queue
```

Valid names are:

| Name | Options |
| --- | --- |
| `queue` | `--driver sync`, `redis`, or `database` (default `sync`) |
| `cache` | `--driver file`, `redis`, or `database` (default `file`) |
| `events` | asks whether to enable queued listeners if no queue is set up |
| `auth` | `--social`, `--provider google,github,discord,facebook,apple,linkedin`, `--workos`, `--clerk` |
| `authorization` | — |
| `notifications` | — |
| `mail` | — |
| `broadcast` | — |
| `realtime` | — |
| `security` | — |
| `media` | — |

For example, to add auth with Google and GitHub login:

```bash
npx holo install auth --provider google,github
```

In an interactive terminal, `holo install auth` without flags asks which providers you want. If a feature is already fully installed, the command reports that and changes nothing.

::: info
`media` is only available through `holo install`. `validation`, `forms`, and `storage` are only offered when you create the project. To add them later, install the package with your package manager (for example `npm install @holo-js/validation @holo-js/forms`) and follow the setup on the [Validation](/basics/validation/), [Forms](/basics/forms/), or [File Storage](/storage/) page.
:::

## Running the CLI

Holo installs the `holo` command into your project as part of `@holo-js/cli`. Run it through your package manager:

::: code-group

```bash [npm]
npx holo migrate
```

```bash [pnpm]
pnpm exec holo migrate
```

```bash [Yarn]
yarn holo migrate
```

```bash [Bun]
bunx holo migrate
```

:::

The rest of these docs write commands as `npx holo ...`. Swap in your package manager's form if you use a different one.

Framework lifecycle commands are package scripts. Run them the normal way, for example `npm run dev`:

| Script | Runs | What it does |
| --- | --- | --- |
| `dev` | `holo dev` | Refreshes generated files, watches your `server/` folders, and starts the framework dev server |
| `build` | `holo build` | Refreshes generated files and runs the framework build |
| `start` | `holo start` | Starts the production server. Accepts `--port` or reads `PORT` from your env |
| `prepare` | `holo key:generate && holo prepare` | Runs when your package manager installs dependencies: creates `APP_KEY` if missing and refreshes generated files |
| `lint` | `eslint ...` | Lints your app, config, and server folders |
| `typecheck` | framework type checker | `tsc`, `nuxt typecheck`, or `svelte-check` |
| `config:cache` | `holo config:cache` | Caches config for production. See [Configuration](/getting-started/configuration#config-cache) |
| `config:clear` | `holo config:clear` | Removes the config cache |

Run `npx holo list` to see every command, including your own [custom commands](/reference/custom-commands). See the [CLI reference](/reference/cli) for details on each one.

## Global install

You can also install the CLI globally so `holo` works without a prefix:

::: code-group

```bash [npm]
npm install -g @holo-js/cli
```

```bash [pnpm]
pnpm add -g @holo-js/cli
```

```bash [Yarn]
yarn global add @holo-js/cli
```

```bash [Bun]
bun add -g @holo-js/cli
```

:::

Then run commands directly:

```bash
holo new my-app --framework sveltekit
holo list
```

`holo new` accepts the same flags as the installer. The package also installs a `holo-js` alias for the same command.

## What the installer creates

Every project gets:

- Framework files for your choice of Next.js, Nuxt, or SvelteKit, already wired to Holo
- `config/app.ts`, `config/database.ts`, and `config/redis.ts`, plus a config file for each optional package
- `.env` and `.env.example` with the keys your packages need
- `server/models`, `server/commands`, and `server/db/` folders for migrations, seeders, factories, and observers
- Folders for each optional package, such as `server/jobs` or `server/policies`
- `storage/`, which holds the SQLite database file when you choose SQLite
- `.holo-js/`, generated files Holo keeps up to date for you
- `tsconfig.json`, `eslint.config.mjs`, and a `.gitignore`

With `auth`, you also get a `User` model, migrations for users, sessions, social identities, API tokens, password resets, email verification, and multi-factor auth, and a current-user endpoint at `/api/auth/user`. Holo does not generate login, registration, or logout pages, because those depend on your UI. The [Authentication](/auth/) guide shows how to build them.

See [Project Structure](/getting-started/project-structure) for a tour of each folder.

## Next steps

- [Project Structure](/getting-started/project-structure)
- [Configuration](/getting-started/configuration)
- [Coding with AI Agents](/getting-started/ai-agents): install Holo skills for Claude, Codex, Cursor, and others
