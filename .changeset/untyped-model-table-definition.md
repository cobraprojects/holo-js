---
'@holo-js/db': patch
---

Treat an untyped model's table definition as its table name in `DB.table()`, `tx.table()`, joins, `belongsToMany()` pivots and `defineModel()`, so a model on another connection no longer rejects every column.
