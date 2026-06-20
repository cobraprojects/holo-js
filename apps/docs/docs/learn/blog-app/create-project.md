# Create the Project

This chapter creates a new Holo-JS app, starts the development server, and confirms the generated project structure.

## What you will build

- a new Holo-JS project
- a selected host framework
- the first app directories users will edit
- a running development server

## Create the app

::: code-group

```bash [npm]
npm create holo-js@latest blog-app
cd blog-app
npm run dev
```

```bash [pnpm]
pnpm create holo-js@latest blog-app
cd blog-app
pnpm dev
```

```bash [Yarn]
yarn create holo-js blog-app
cd blog-app
yarn dev
```

```bash [Bun]
bun create holo-js blog-app
cd blog-app
bun run dev
```

:::

For this learning path, choose:

- Next.js, Nuxt, or SvelteKit for the host framework
- SQLite for the first database
- local storage for the first storage disk
- validation, forms, auth, authorization, storage, media, notifications, broadcast, realtime, queue, and cache when prompted for optional packages

## Generated structure

After scaffolding, the important app directories are:

```txt
config/
server/db/
server/models/
server/policies/
server/events/
server/listeners/
server/jobs/
server/mail/
storage/
```

The host framework still owns routes, rendering, and SSR. Holo owns backend runtime services, configuration, database access, models, queues, events, storage, mail, and related server-side features.

## Checkpoint

Open the app in the browser and confirm the starter page loads.

You are ready for the next chapter when:

- the dev server is running without errors
- the browser shows the app
- the project has `config/`, `server/`, and `storage/` directories

## Next step

The next chapter creates the blog database tables.

## Related reference

- [Installation](/installation)
- [Configuration](/configuration)
- [Directory Structure](/directory-structure)
- [Runtime Services](/runtime-services)
