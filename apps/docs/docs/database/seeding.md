# Seeding

Seeders prepare an environment with named, repeatable data sets.

Use seeders for:

- local development bootstrap data
- demo accounts and showcase data
- reference data such as roles, plans, and settings
- repeatable environment setup in CI or staging

Use factories when you need flexible generated records. Use seeders when the setup step itself should be
callable by name, such as `database`, `roles`, or `demo_content`.

## Where seeders live

Seeders live under `server/db/seeders`.

```text
server/db/seeders/RolesSeeder.ts
server/db/seeders/AdminSeeder.ts
server/db/seeders/DatabaseSeeder.ts
```

## Create a seeder

```bash
npx holo make:seeder RolesSeeder
```

Create `server/db/seeders/RolesSeeder.ts`:

```ts
import { defineSeeder } from '@holo-js/db'
import Role from '../../models/Role'

export default defineSeeder({
  name: 'roles',
  async run() {
    await Role.unguarded(async () => {
      await Role.firstOrCreate({ slug: 'admin' }, { name: 'Admin' })
      await Role.firstOrCreate({ slug: 'editor' }, { name: 'Editor' })
      await Role.firstOrCreate({ slug: 'viewer' }, { name: 'Viewer' })
    })
  },
})
```

Create `server/db/seeders/AdminSeeder.ts`:

```ts
import { hashPassword } from '@holo-js/auth'
import { defineSeeder } from '@holo-js/db'
import User from '../../models/User'

export default defineSeeder({
  name: 'admin',
  async run() {
    const password = await hashPassword('secret-secret')

    await User.unguarded(() =>
      User.updateOrCreate(
        { email: 'admin@example.com' },
        {
          name: 'Admin',
          password,
          role: 'admin',
        },
      ),
    )
  },
})
```

Keep each seeder focused on one setup concern.

## Create a root seeder

Use a root seeder to run a complete setup path.

```bash
npx holo make:seeder DatabaseSeeder
```

Create `server/db/seeders/DatabaseSeeder.ts`:

```ts
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'database',
  async run({ call }) {
    await call('roles')
    await call('admin')
  },
})
```

Use separate `call(...)` statements when order matters.

## Run seeders

```bash
npx holo seed
npx holo seed --only database
npx holo seed --only roles,admin
npx holo seed --quietly
npx holo seed --force
```

`npx holo seed` runs registered seeders discovered from `server/db/seeders`.

Use `--only` when you want one named setup path instead of every registered seeder.

## Run seeders after fresh migrations

```bash
npx holo migrate:fresh --seed
npx holo migrate:fresh --seed --only database
npx holo migrate:fresh --seed --quietly
npx holo migrate:fresh --seed --force
```

`migrate:fresh --seed` drops the database tables, reruns migrations, then runs seeders.

## Call seeders from code

```ts
import { DB, createSeederService } from '@holo-js/db'
import AdminSeeder from './AdminSeeder'
import DatabaseSeeder from './DatabaseSeeder'
import RolesSeeder from './RolesSeeder'

const seeders = createSeederService(DB.connection(), [
  RolesSeeder,
  AdminSeeder,
  DatabaseSeeder,
])

await seeders.seed({ only: ['database'] })
```

## Seeder context

`run(...)` receives:

- `db` for the active database connection
- `schema` for schema operations
- `call(...)` for running other registered seeders

```ts
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'setup',
  async run({ schema, call }) {
    await schema.createTable('settings', (table) => {
      table.id()
      table.string('key')
      table.string('value')
    })

    await call('roles')
  },
})
```

## When seeders run

Seeders run only when you call them explicitly.

Common places:

- `npx holo seed`
- `npx holo migrate:fresh --seed`
- test setup
- development bootstrap scripts
- staging or deployment bootstrap tooling

Seeders are not run by model creation, migrations without `--seed`, route registration, or normal server
startup.

## Transactions

Each seeder runs inside a transaction. If the seeder throws, its writes roll back.

Nested seeders called with `call(...)` reuse the active seeder transaction.

## Production safety

Production seeding is blocked unless `force` is enabled.

```ts
await seeders.seed({
  only: ['database'],
  environment: 'production',
  force: true,
})
```

The CLI uses `APP_ENV`, then `NODE_ENV`, then `development` as the seeding environment.

## Quiet seeding

Use `quietly` to disable model events while seeders run.

```ts
await seeders.seed({
  only: ['database'],
  quietly: true,
})
```

## Factories

Use factories inside seeders when the seeded data needs related model graphs.

```ts
await UserFactory
  .has(PostFactory.count(3), 'posts')
  .create()
```

## Continue

- [ORM Factories](/orm/factories)
- [Database Getting Started](/database/)
