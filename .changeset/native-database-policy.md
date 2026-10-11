---
'@holo-js/kernel': patch
'@holo-js/db': patch
'@holo-js/security': patch
'@holo-js/realtime': patch
---

Allow native database connections to opt into raw SQL with `security.allowUnsafeRawSql`. Forward the boolean policy through application boot, migrations, and transactions while retaining the disabled default. Gate releases on real PostgreSQL RLS migrations, concurrent tenant isolation, transaction-local context cleanup through native application configuration, and complete example-app browser journeys.

Prevent concurrent pooled transactions from deadlocking behind a shared serialized query queue. Send the configured CSRF cookie token on realtime HTTP requests so strict protection permits legitimate browser queries and mutations.
