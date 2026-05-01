# Database Commands

Holo-JS ships internal CLI commands through the `@holo-js/cli` package and its `holo` binary for the everyday database workflow:
scaffolding files, running migrations, seeding data, and pruning models.

Inside a project, run direct Holo-JS commands through your package manager:

```bash
npx holo list
```

Equivalent forms:

- `pnpm dlx holo ...`
- `yarn dlx holo ...`
- `npx holo ...`

Use package scripts such as `npm run dev` and `npm run build` for framework lifecycle commands.

Use `holo list` to see every available command. The output groups Holo-JS's internal commands separately
from app commands auto-discovered from `server/commands`.

## Command discovery

```bash
npx holo list
```

Use this as the entry point when you want to see the installed internal commands and any custom commands
your app provides.

## Scaffolding commands

### Create a model

```bash
npx holo make:model User
npx holo make:model courses/Course --migration --observer --factory --seeder
```

`make:model` creates files under:

- `server/models`
- `server/db/observers`
- `server/db/factories`
- `server/db/seeders`
- `server/db/migrations`

It also refreshes Holo-JS discovery output so runtime commands can see the generated model, seeder, and
migration registries.

### Create a migration

```bash
npx holo make:migration create_users_table
npx holo make:migration create_users_table --create users
npx holo make:migration add_status_to_users_table --table users
```

This creates a timestamped migration in `server/db/migrations`. `holo prepare`, `holo dev`, and
`holo build` keep the generated registries current.

Use:

- `--create users`
  - when the migration is creating a new table
- `--table users`
  - when the migration is changing an existing table

The generator can still infer common create, alter, and drop shapes from conventional file names, but
the flags make the intended scaffold explicit.

### Create cache tables

```bash
npx holo cache:table
```

Use this when your cache config uses the `database` driver. The generator creates a normal migration file under
`server/db/migrations` for the cache entry and cache lock tables.

### Create a seeder

```bash
npx holo make:seeder RoleSeeder
```

This creates a seeder in `server/db/seeders` and refreshes generated discovery artifacts when the next
prepare step runs.

### Create an observer

```bash
npx holo make:observer UserObserver
npx holo make:observer courses/CourseObserver
```

This creates an observer in `server/db/observers`. Standalone observer generation does not rewrite an
existing model automatically. If you want the observer wired into a new model immediately, use
`make:model --observer`.

### Create a factory

```bash
npx holo make:factory UserFactory
```

This creates a factory in `server/db/factories`.

## Runtime commands

### Run migrations

```bash
npx holo migrate
npx holo migrate --step 1
```

### Refresh the database from scratch

```bash
npx holo migrate:fresh
npx holo migrate:fresh --seed
npx holo migrate:fresh --seed --only roles,users
npx holo migrate:fresh --seed --force
```

`migrate:fresh` drops every table in the active connection, reruns all registered migrations from
scratch, and refreshes `server/db/schema.generated.ts` at the end of the migration pass.

Use `--seed` when you want the fresh database to be reseeded immediately after migrations finish.
The seeding flags match `holo seed`:

- `--only roles,users`
- `--quietly`
- `--force`

### Roll back migrations

```bash
npx holo migrate:rollback
npx holo migrate:rollback --batch 1
npx holo migrate:rollback --step 1
```

### Run seeders

```bash
npx holo seed
npx holo seed --only database
npx holo seed --only roles,users
npx holo seed --quietly
npx holo seed --force
```

`seed` runs the seeders discovered from `server/db/seeders`.

### Prune models

```bash
npx holo prune
npx holo prune Session
npx holo prune Session AuditLog
```

`prune` works in two modes:

- with no arguments, it prunes every registered model that defines `prunable`
- with one or more model names, it prunes only that explicit set

If you name an unknown model, the command fails. If you name a registered model that does not define
`prunable`, the command also fails. When no model names are passed and no registered models are prunable,
the command succeeds and reports that there was nothing to prune.

### Cache maintenance

```bash
npx holo cache:clear
npx holo cache:clear --driver redis
npx holo cache:forget dashboard.stats
```

Use these commands when you want to clear one configured store or drop one specific key without writing a custom
script.

## Interactive prompts

If a required argument is missing and the terminal session is interactive, Holo-JS prompts for it instead
of failing immediately.

For example, this will ask for the model name:

```bash
npx holo make:model
```

Some generator commands also ask follow-up questions for optional scaffolding when that makes the workflow
faster.

Disable prompts explicitly with:

```bash
npx holo make:model --no-interactive
```

In non-interactive environments, missing required values fail immediately.

## Project discovery

Runtime commands read generated registries under `.holo-js/generated` to find:

- models
- migrations
- seeders
- commands
- discovery metadata

Generator commands and `holo prepare` keep those artifacts in sync for you.

## App commands

App commands are auto-discovered from `server/commands` without registration.

Example:

```text
server/commands/courses/reindex.ts
```

```ts
import { defineCommand } from '@holo-js/cli'

export default defineCommand({
  description: 'Reindex course data.',
  async run() {
    console.log('courses reindexed')
  },
})
```

That file is available as:

```bash
npx holo courses:reindex
```

If the file does not provide an explicit `name`, the command name is derived from its path under
`server/commands`.
