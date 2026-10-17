# 1. Create the Project

In this chapter you create a new Holo-JS app, choose the packages the blog needs, and start the development server.

## What you'll build

- a new project called `blog`
- a SQLite database file for local development
- the folders you'll edit in the rest of the tutorial
- a running development server

## Step 1: Create the app

Run the project creator:

```bash
npm create holo-js@latest blog
```

To use pnpm, Yarn, or Bun instead, see [Installation](/getting-started/installation).

The creator asks a few questions. Answer them like this:

| Question | Answer |
| --- | --- |
| Framework | `next`, `nuxt`, or `sveltekit` — your choice |
| Database driver | `sqlite` |
| Package manager | `npm` |
| Optional packages | select all of them |
| Default storage disk | `local` |

The optional packages are `storage`, `events`, `queue`, `validation`, `forms`, `auth`, `authorization`, `notifications`, `mail`, `broadcast`, `realtime`, `security`, and `cache`. The blog uses every one of them by the end of the tutorial. You'll add image support (`media`) later, in [chapter 9](/tutorial/media-uploads).

::: tip Skip the questions
You can pass every answer as a flag instead. Replace `next` with `nuxt` or `sveltekit` if needed:

```bash
npm create holo-js@latest blog -- --framework next --database sqlite --package-manager npm --storage-default-disk local --package storage,events,queue,validation,forms,auth,authorization,notifications,mail,broadcast,realtime,security,cache
```
:::

The creator writes the project files and installs dependencies. When it finishes, it prints the next steps.

## Step 2: Start the development server

```bash
cd blog
npm run dev
```

The `dev` script runs `holo dev`. It prepares Holo's generated files, then starts your framework's own dev server.

Open the URL printed in the terminal. By default that's `http://localhost:3000` for Next.js and Nuxt, and `http://localhost:5173` for SvelteKit. You should see the starter page.

## Step 3: Look around the project

Your framework's usual folders are still there (`app/` for Next.js and Nuxt, `src/` for SvelteKit). Holo adds these:

| Folder | What goes in it |
| --- | --- |
| `config/` | One file per feature: `app.ts`, `database.ts`, `auth.ts`, `storage.ts`, `queue.ts`, and so on |
| `server/models/` | Models. The creator already made `User.ts` for you |
| `server/db/migrations/` | Migrations. The auth and notifications tables are already here |
| `server/db/seeders/` | Seeders that fill the database with sample data |
| `server/policies/` | Authorization policies |
| `server/events/`, `server/listeners/` | Events and the listeners that react to them |
| `server/jobs/` | Queued jobs |
| `server/broadcast/`, `server/channels/` | Broadcast events and channels for live updates |
| `server/realtime/` | Realtime queries and mutations |
| `server/notifications/` | Notifications, including the auth emails |
| `storage/` | The SQLite database, uploaded files, sessions, and other local data |
| `.env` | Local settings such as `APP_URL` and `DB_URL` |

Holo also keeps a `.holo-js/generated/` folder. Holo regenerates this folder; don't edit it.

## Step 4: Check it works

1. The browser shows the starter page with no errors in the terminal.
2. In a second terminal, inside the `blog` folder, list the Holo commands:

   ```bash
   npx holo list
   ```

   You should see commands such as `migrate`, `make:model`, `seed`, and `queue:work`.

3. Open `.env` and check that `DB_URL` is set to `./storage/database.sqlite`. That's where your data will live.

Leave the dev server running for the rest of the tutorial. Holo notices new models, migrations, and policies while it runs.

## Next steps

Next, create the blog's tables in [Database and Migrations](/tutorial/database-and-migrations).

For more detail on what you just did:

- [Installation](/getting-started/installation)
- [Project Structure](/getting-started/project-structure)
- [Configuration](/getting-started/configuration)
- [CLI Commands](/reference/cli)
