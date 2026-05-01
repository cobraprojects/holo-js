# Setup And CLI

## New projects

Scaffold cache during project creation:

```bash
npm create holo-js@latest my-app -- --package cache
```

That adds `@holo-js/cache`, writes `config/cache.ts`, and adds `CACHE_PREFIX` to `.env` files.

## Existing projects

Install cache into an existing app:

```bash
npx holo install cache
```

Pick an explicit driver when needed:

```bash
npx holo install cache --driver file
npx holo install cache --driver redis
npx holo install cache --driver database
```

`file` is the default install target and the default runtime driver.

Install output by driver:

- `file`
  - installs `@holo-js/cache`
  - writes `config/cache.ts`
  - writes `CACHE_PREFIX=`
- `redis`
  - installs `@holo-js/cache` and `@holo-js/cache-redis`
  - writes `config/cache.ts`
  - writes `config/redis.ts` if missing
  - writes `CACHE_PREFIX=`
- `database`
  - installs `@holo-js/cache` and `@holo-js/cache-db`
  - writes `config/cache.ts`
  - writes `CACHE_PREFIX=`
  - offers `holo cache:table`

## Cache maintenance commands

Clear the default cache store:

```bash
npx holo cache:clear
```

Clear a named cache store:

```bash
npx holo cache:clear --driver redis
```

Forget one key from the default cache store:

```bash
npx holo cache:forget dashboard.stats
```

Forget one key from a named cache store:

```bash
npx holo cache:forget dashboard.stats --driver redis
```

## Database cache tables

If your cache driver is `database`, generate the migration and then migrate normally:

```bash
npx holo cache:table
npx holo migrate
```

`cache:table` creates a normal app migration under `server/db/migrations`. Holo-JS does not hide cache
tables inside a package.

## Typical setup flows

### File cache

```bash
npx holo install cache --driver file
```

### Redis cache

```bash
npx holo install cache --driver redis
```

Use `npx holo cache:clear --driver redis` later when you need to clear existing Redis cache state during migration or
troubleshooting.

### Database cache

```bash
npx holo install cache --driver database
npx holo cache:table
npx holo migrate
```

## Continue

- [Config and Drivers](/cache/config-and-drivers)
- [Runtime API, Locks, and Query Caching](/cache/runtime-and-query-caching)
- [Database Commands](/database/commands)
