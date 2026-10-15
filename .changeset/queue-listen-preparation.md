---
'@holo-js/cli': patch
---

Ignore generated discovery output when watching queue sources, and wait for queued project preparation to finish before restarting a worker so it cannot read partially regenerated framework configuration.
