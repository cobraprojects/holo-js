# Database Commands

Holo-JS ships internal CLI commands through the `@holo-js/cli` package and its `holo` binary for the everyday database workflow:
scaffolding files, running migrations, seeding data, and pruning models.

Inside a project, run direct Holo-JS commands through your package manager:

```bash
bunx holo list
```

Equivalent forms:

- `npx holo ...`
- `pnpm dlx holo ...`
- `yarn dlx holo ...`

Use package scripts such as `bun run dev` and `bun run build` for framework lifecycle commands.

Use `holo list` to see every available command. The output groups Holo-JS's internal commands separately
from app commands auto-discovered from `server/commands`.

## Command discovery

```bash
bunx holo list
```

Use this as the entry point when you want to see the installed internal commands and any custom commands
your app provides.

## Scaffolding commands

### Create a model

```bash
bunx holo make:model User
bunx holo make:model courses/Course --migration --observer --factory --seeder
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
bunx holo make:migration create_users_table
bunx holo make:migration create_users_table --create users
bunx holo make:migration add_status_to_users_table --table users
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

### Create a seeder

```bash
bunx holo make:seeder RoleSeeder
```

This creates a seeder in `server/db/seeders` and refreshes generated discovery artifacts when the next
prepare step runs.

### Create an observer

```bash
bunx holo make:observer UserObserver
bunx holo make:observer courses/CourseObserver
```

This creates an observer in `server/db/observers`. Standalone observer generation does not rewrite an
existing model automatically. If you want the observer wired into a new model immediately, use
`make:model --observer`.

### Create a factory

```bash
bunx holo make:factory UserFactory
```

This creates a factory in `server/db/factories`.

## Runtime commands

### Run migrations

```bash
bunx holo migrate
bunx holo migrate --step 1
```

### Refresh the database from scratch

```bash
bunx holo migrate:fresh
bunx holo migrate:fresh --seed
bunx holo migrate:fresh --seed --only roles,users
bunx holo migrate:fresh --seed --force
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
bunx holo migrate:rollback
bunx holo migrate:rollback --batch 1
bunx holo migrate:rollback --step 1
```

### Run seeders

```bash
bunx holo seed
bunx holo seed --only database
bunx holo seed --only roles,users
bunx holo seed --quietly
bunx holo seed --force
```

`seed` runs the seeders discovered from `server/db/seeders`.

### Prune models

```bash
bunx holo prune
bunx holo prune Session
bunx holo prune Session AuditLog
```

`prune` works in two modes:

- with no arguments, it prunes every registered model that defines `prunable`
- with one or more model names, it prunes only that explicit set

If you name an unknown model, the command fails. If you name a registered model that does not define
`prunable`, the command also fails. When no model names are passed and no registered models are prunable,
the command succeeds and reports that there was nothing to prune.

## Interactive prompts

If a required argument is missing and the terminal session is interactive, Holo-JS prompts for it instead
of failing immediately.

For example, this will ask for the model name:

```bash
bunx holo make:model
```

Some generator commands also ask follow-up questions for optional scaffolding when that makes the workflow
faster.

Disable prompts explicitly with:

```bash
bunx holo make:model --no-interactive
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
bunx holo courses:reindex
```

If the file does not provide an explicit `name`, the command name is derived from its path under
`server/commands`.
