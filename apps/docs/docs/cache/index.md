# Cache

`@holo-js/cache` gives Holo-JS a unified cache API across four first-party drivers:

- `memory`
- `file`
- `redis`
- `database`

Core APIs used throughout these docs:

- `cache.get(...)`
- `cache.put(...)`
- `cache.remember(...)`
- `cache.flexible(...)`
- `cache.lock(...)`
- `query.cache(...)`

Use cache when you want:

- a simple key/value store for computed data
- request-safe or process-safe locks
- shared Redis-backed caching across app nodes
- portable database-backed caching
- query result caching from `@holo-js/db`

## Documentation

- [Setup and CLI](/cache/setup-and-cli)
- [Config and Drivers](/cache/config-and-drivers)
- [Runtime API, Locks, and Query Caching](/cache/runtime-and-query-caching)
