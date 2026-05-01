# Directory Structure

Holo-JS owns a small set of canonical directories. The host framework keeps its normal app structure on
top of that.

## Typical layout

```text
my-app/
├── config/
│   ├── app.ts
│   ├── database.ts
│   ├── queue.ts
│   └── storage.ts
├── server/
│   ├── commands/
│   ├── db/
│   │   ├── factories/
│   │   ├── migrations/
│   │   ├── observers/
│   │   ├── schema/
│   │   └── seeders/
│   ├── jobs/
│   ├── events/
│   ├── listeners/
│   └── models/
├── storage/
├── .env
├── .env.example
├── .holo-js/
│   └── generated/
└── framework files...
```

## What users edit

These are the normal user-owned surfaces:

- `config/*.ts`
- `.env` and the environment-specific env files
- `server/models`
- `server/db`
- `server/commands`
- `server/jobs`
- `server/events`
- `server/listeners`
- the host framework's app files

## What Holo-JS owns

`.holo-js/generated` is machine-owned output. `.holo-js/runtime` is internal runtime and CLI scratch space.
Do not edit either by hand.

They contain generated registries, metadata, and transient runtime artifacts used by adapters, runtime boot,
and CLI execution.

## Canonical directories

### `config/`

Server-side config files live here. Add first-party and custom app config files in this directory.

### `server/models`

Put `defineModel()` definitions here.

Example:

```text
server/models/User.ts
server/models/Post.ts
server/models/courses/Course.ts
```

### `server/db/migrations`

Store migration files here. Keep them deterministic and reviewable.

### `server/db/factories`

Put factories here for tests and repeatable local data.

### `server/db/seeders`

Put seeders here for baseline and development data.

### `server/db/observers`

Put observers here when model lifecycle behavior should move out of the model file.

### `server/commands`

Put app-specific CLI commands here. Holo-JS auto-discovers them during `holo prepare`.

Example:

```text
server/commands/courses/reindex.ts
server/commands/db/reset.ts
```

### `server/jobs`

Put queue jobs here. Holo-JS auto-discovers them during `holo prepare`.

Example:

```text
server/jobs/reports/send-digest.ts
server/jobs/cache/prune.ts
```

### `server/events`

Put event definitions here. Holo-JS auto-discovers them during `holo prepare`.

Example:

```text
server/events/user/registered.ts
server/events/billing/invoice-paid.ts
```

### `server/listeners`

Put event listeners here. Holo-JS auto-discovers them during `holo prepare`.

Example:

```text
server/listeners/user/send-welcome-email.ts
server/listeners/billing/sync-invoice-state.ts
```

## Host framework files

Framework-owned files depend on the selected adapter.

Nuxt usually adds:

```text
app.vue
nuxt.config.ts
```

Next.js usually adds:

```text
app/
next.config.ts
```

SvelteKit usually adds:

```text
src/routes/
svelte.config.js
vite.config.ts
```

Holo-JS does not replace those layouts.

## Discovery commands

Use:

```bash
holo dev
holo build
holo prepare
```

`holo dev` and `holo build` keep `.holo-js/generated` in sync with `server/models`, `server/db`,
`server/commands`, `server/jobs`, `server/events`, and `server/listeners`. Use `holo prepare` only when
you want to refresh discovery output without starting the framework runtime.
