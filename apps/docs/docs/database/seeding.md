# Seeding

Seeders fill your database with data: reference rows like roles and plans, an admin account, or a batch of fake posts for local development. Each seeder has a name, so you can run one setup step on its own or all of them together.

```bash
npx holo make:seeder RolesSeeder
```

```ts [server/db/seeders/RolesSeeder.ts]
import { defineSeeder } from '@holo-js/db'
import Role from '../../models/Role'

export default defineSeeder({
  name: 'roles',
  async run() {
    await Role.firstOrCreate({ slug: 'admin' }, { name: 'Admin' })
    await Role.firstOrCreate({ slug: 'editor' }, { name: 'Editor' })
  },
})
```

```bash
npx holo seed
```

## Writing seeders

`make:seeder` creates a file in `server/db/seeders`. The `name` comes from the file name without the `Seeder` suffix, in snake case: `RolesSeeder` becomes `roles`, `DemoContentSeeder` becomes `demo_content`. You use this name with `--only` and `call()`.

Inside `run()`, use your [models](/orm/) or the [query builder](/database/query-builder/) as usual. `run()` also receives a context:

| Property | What it is |
| --- | --- |
| `db` | The database connection |
| `schema` | The schema builder, same as in [migrations](/database/migrations) |
| `call(...names)` | Runs other seeders by name |

```ts [server/db/seeders/SettingsSeeder.ts]
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'settings',
  async run({ db }) {
    await db.table('settings').insert({ key: 'site_name', value: 'My Blog' })
  },
})
```

::: tip
Use `firstOrCreate()` or `updateOrCreate()` for reference data so running the seeder twice doesn't create duplicates.
:::

## Using factories

[Factories](/orm/factories) are the easiest way to create lots of realistic records:

```ts [server/db/seeders/DemoContentSeeder.ts]
import { defineSeeder } from '@holo-js/db'
import PostFactory from '../factories/PostFactory'
import UserFactory from '../factories/UserFactory'

export default defineSeeder({
  name: 'demo_content',
  async run() {
    await UserFactory
      .count(5)
      .has(PostFactory.count(3), 'posts')
      .create()
  },
})
```

## Calling other seeders

A root seeder can run the others in a fixed order with `call()`:

```ts [server/db/seeders/DatabaseSeeder.ts]
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'database',
  async run({ call }) {
    await call('roles')
    await call('settings')
    await call('demo_content')
  },
})
```

Run it on its own with `--only`:

```bash
npx holo seed --only database
```

::: warning
`npx holo seed` without `--only` runs **every** seeder in `server/db/seeders`. If a root seeder calls the others, they run twice. Use `--only database` when you rely on a root seeder.
:::

## Running seeders

```bash
npx holo seed
npx holo seed --only roles,settings
```

Reset the database and seed it in one step:

```bash
npx holo migrate:fresh --seed --only database
```

| Flag | Effect |
| --- | --- |
| `--only <names>` | Run only these seeders. Comma-separated, or repeat the flag |
| `--quietly` | Turn off [model events and observers](/orm/observers) while seeding |
| `--force` | Allow seeding in production |

### Transactions

Each seeder runs in a transaction. If it throws, everything it wrote rolls back. Seeders started with `call()`, and any model writes inside them, join the same transaction, so a failing root seeder undoes the whole run.

### Seeding in production

Holo refuses to seed when the environment is `production`. The environment comes from `APP_ENV` and is `production` when `APP_ENV` isn't set. Pass `--force` when you really mean it:

```bash
npx holo seed --only roles --force
```

## Seeder reference

### defineSeeder()

Declares a seeder. It takes an object with a `name` (string) and a `run(context)` function, and returns that object.

```ts [server/db/seeders/SettingsSeeder.ts]
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'settings',
  async run({ db }) {
    await db.table('settings').insert({ key: 'site_name', value: 'My Blog' })
  },
})
```

### call()

Runs other seeders by name, in the order you list them, inside the current seeder's transaction. It is available on the context passed to `run()`.

```ts [server/db/seeders/DatabaseSeeder.ts]
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'database',
  async run({ call }) {
    await call('roles', 'settings')
  },
})
```

### Context properties

`run()` receives these properties:

| Property | Type | Meaning |
| --- | --- | --- |
| `db` | connection | The active database connection. Use `db.table()` for query builder calls. |
| `schema` | schema builder | Creates and changes tables, same as in [migrations](/database/migrations) |

### Seed options

The seeder run accepts these options. The CLI sets them from the flags in [Running seeders](#running-seeders).

| Option | Meaning |
| --- | --- |
| `only` | Names of the seeders to run. Unknown names throw. |
| `quietly` | Turn off model events and observers while seeding |
| `force` | Allow seeding when `environment` is `production` |
| `environment` | Environment name used for the production check. The CLI passes the [app environment](/reference/environment#env-files-and-loading-order). |

## Next steps

- [Factories](/orm/factories)
- [Migrations](/database/migrations)
- [Database Tests](/testing/database)
