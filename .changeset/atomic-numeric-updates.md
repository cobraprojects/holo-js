---
'@holo-js/db': patch
---

Perform increment and decrement arithmetic in a single database UPDATE rather than reading values into per-row writes. Preserve concurrent counter updates, bulk predicates, extra values, bounded selections, and concrete mutation notifications.
