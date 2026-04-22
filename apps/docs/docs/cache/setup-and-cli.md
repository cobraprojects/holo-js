# Setup And CLI

## New projects

Scaffold cache during project creation:

```bash
bun create holo-js my-app --package cache
```

That adds `@holo-js/cache`, writes `config/cache.ts`, and adds `CACHE_PREFIX` to `.env` files.

## Existing projects

Install cache into an existing app:

```bash
bunx holo install cache
```

Pick an explicit driver when needed:

```bash
bunx holo install cache --driver file
bunx holo install cache --driver redis
bunx holo install cache --driver database
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
bunx holo cache:clear
```

Clear a named cache store:

```bash
bunx holo cache:clear --driver redis
```

Forget one key from the default cache store:

```bash
bunx holo cache:forget dashboard.stats
```

Forget one key from a named cache store:

```bash
bunx holo cache:forget dashboard.stats --driver redis
```

## Database cache tables

If your cache driver is `database`, generate the migration and then migrate normally:

```bash
bunx holo cache:table
bunx holo migrate
```

`cache:table` creates a normal app migration under `server/db/migrations`. Holo-JS does not hide cache
tables inside a package.

## Typical setup flows

### File cache

```bash
bunx holo install cache --driver file
```

### Redis cache

```bash
bunx holo install cache --driver redis
```

Use `bunx holo cache:clear --driver redis` later when you need to clear existing Redis cache state during migration or
troubleshooting.

### Database cache

```bash
bunx holo install cache --driver database
bunx holo cache:table
bunx holo migrate
```

## Continue

- [Config and Drivers](/cache/config-and-drivers)
- [Runtime API, Locks, and Query Caching](/cache/runtime-and-query-caching)
- [Database Commands](/database/commands)
