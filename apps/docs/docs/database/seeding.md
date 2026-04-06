# Seeding

Seeders prepare an environment with named, repeatable data sets. In Holo-JS, seeders are runtime services,
not throwaway test scripts.

## What seeders are for

Use seeders when the dataset itself deserves a name and a repeatable lifecycle.

Typical cases:

- local development bootstrap data
- demo accounts and showcase data
- reference data such as roles, plans, and settings
- repeatable environment setup in CI or staging

Use a factory when you want flexible shape-valid records. Use a seeder when you want a named setup step
such as `DatabaseSeeder`, `RoleSeeder`, or `DemoContentSeeder`.

## Where seeder files live

Put seeders in a server-side folder such as:

```text
server/db/seeders/
```

Example:

```text
server/db/seeders/RoleSeeder.ts
server/db/seeders/UserSeeder.ts
server/db/seeders/DatabaseSeeder.ts
```

They belong on the server because they touch the database directly.

## Writing a seeder

Create `/server/db/seeders/RoleSeeder.ts`.

The CLI can scaffold the file for you:

```bash
holo make:seeder RoleSeeder
```

```ts
import { defineSeeder } from '@holo-js/db'
import { Role } from '../../models/Role'
import { RoleFactory } from '../factories/RoleFactory'

export const RoleSeeder = defineSeeder({
  name: 'roles',
  async run() {
    await RoleFactory.createMany([
      { name: 'admin' },
      { name: 'editor' },
      { name: 'viewer' },
    ])
  },
})
```

Keep one seeder focused on one record family or one setup concern.

## Writing a root seeder

Create `/server/db/seeders/DatabaseSeeder.ts`.

```ts
import { defineSeeder } from '@holo-js/db'
import { RoleSeeder } from './RoleSeeder'
import { UserSeeder } from './UserSeeder'

export const DatabaseSeeder = defineSeeder({
  name: 'database',
  async run({ call }) {
    await call('roles', 'users')
  },
})
```

The root seeder should orchestrate. Smaller seeders should own the actual record setup.

## How seeders are called

Seeders do not run automatically. The normal operational path is the CLI:

```bash
holo seed
holo seed --only database
holo seed --only roles,users
holo seed --quietly
holo seed --force
```

Under the hood, the application or a script can still create a seeder service and call it directly.

Example server script:

```ts
import { DB, createSeederService } from '@holo-js/db'
import { DatabaseSeeder } from './DatabaseSeeder'
import { RoleSeeder } from './RoleSeeder'
import { UserSeeder } from './UserSeeder'

const seeders = createSeederService(DB.connection(), [
  RoleSeeder,
  UserSeeder,
  DatabaseSeeder,
])

await seeders.seed({ only: ['database'] })
```

This is the normal pattern:

1. import the seeders you want registered
2. create a seeder service for the active DB connection
3. call `seed(...)`

## When seeders are called

Seeders run only when you call them explicitly.

Typical places to call them:

- a dev-only bootstrap script
- the built-in `holo seed` command
- a local setup route protected for internal use
- test environment setup
- deployment or staging bootstrap tooling

They are not called by:

- model creation
- migrations
- route registration
- normal server startup

If your application needs seed data automatically, you must write that startup or script logic yourself.

## Running named seeders

```ts
await seeders.seed({ only: ['roles'] })
await seeders.seed({ only: ['database'] })
```

Use `only` when you want one deterministic setup path instead of every registered seeder.

## Calling additional seeders from inside a seeder

```ts
export const DatabaseSeeder = defineSeeder({
  name: 'database',
  async run({ call }) {
    await call('roles')
    await call('users')
    await call('posts')
  },
})
```

That keeps the top-level seeding workflow readable and avoids one giant seeder file.

## Transactions and rollback

Each seeder runs inside a transaction. If the seeder throws, its writes roll back.

This matters because seeders are usually used for environment setup. Partial seed runs are rarely useful.

## Production safety

Production seeding is blocked unless you force it explicitly.

```ts
await seeders.seed({
  only: ['database'],
  environment: 'production',
  force: true,
})
```

This is there to stop accidental production data bootstrapping.

## Quiet seeding

Seeders can run quietly when model events would only add noise or trigger side effects you do not want for
bootstrap data.

```ts
await seeders.seed({
  only: ['database'],
  quietly: true,
})
```

Use this for demo data or local bootstrap flows where observers, notifications, or audit hooks should stay
silent.

## Using model factories inside seeders

Factories are the normal way to create realistic seeded graphs:

```ts
await UserFactory
  .has(PostFactory.count(3), 'posts')
  .create()
```

Use factories inside seeders when:

- the records should still respect model rules
- the graph has relations
- the data should look realistic without hand-writing every foreign key

## Practical rule

Use a seeder when the data setup should be callable by name. Use factories inside that seeder to generate
the records cleanly.

## Continue

- [ORM Factories](/orm/factories)
- [Database Getting Started](/database/)
