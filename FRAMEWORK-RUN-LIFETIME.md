# Framework run lifetime

Status: behavior decisions agreed and published as [GitHub issue #63](https://github.com/cobraprojects/holo-js/issues/63).

The GitHub issue is the implementation spec. Implementation has not begun.

## Scope

Deepen framework run lifetime ownership for `holo dev` and `holo start`.
Preserve their existing exported interfaces and framework runner behavior.
Build and queue workers remain outside this change.

## Ownership

One internal module owns framework process launch, stream attachment and
detachment, signal listeners, platform-aware termination, and completion.
Its lifetime covers initial preparation, active runs, and gaps between runs.

Development retains discovery, watching, preparation, and the policy deciding
when a framework restart is needed. Shutdown reaches that policy through
cancellation and cleanup so no subsequent framework run launches.

The existing process seam uses POSIX signal forwarding and Windows process-tree
termination. Both framework restart and framework shutdown use that termination
path. Introduce no process-group tracking or automatic kill deadline.

Depth comes from hiding process coordination behind the internal interface.
Locality concentrates lifetime invariants in one implementation; leverage comes
from sharing that ownership between development and production startup.

## Agreed behavior

- Shutdown takes priority over restart, aborts preparation, closes watchers,
  and prevents another launch.
- Restart requires closure of the previous framework process. A process error
  does not authorize a replacement; report a stopping failure instead of
  treating it as a successful reload.
- Changes arriving during a restart coalesce. Finish queued preparation before
  launching the replacement with the latest successfully prepared configuration.
- Failed development preparation reports the failure and leaves the current
  framework run active. Only successful preparation requests a restart.
- Initial preparation failure prevents launch.
- Every exit path releases owned streams, watchers, and signal listeners.

## Validation

Keep existing real-process signal, port-release, and listener-cleanup tests.
Protect distinct behavior through the existing dev/start interface:

- Restart waits for closure and does not launch after a stopping error.
- Shutdown during preparation or restart prevents a launch and releases resources.
- Queued changes prepare before one replacement launches with current arguments.
- Failed preparation preserves the active run; initial failure prevents launch.
- Windows restart uses the same process-tree termination as shutdown.

Prefer real processes and temporary projects. Use a substitute only where
platform-specific failure or event ordering cannot be exercised deterministically.
Replace the existing test that treats a restart error without closure as a
successful reload with coverage of the agreed failure behavior.

Run tests with parallel execution enabled and Vitest's JSON reporter. After
implementation, run diagnostics on modified executable files, `bun run typecheck`,
and ESLint with fixes on changed executable files.

## Evidence

- `packages/cli/src/dev.ts` contains managed termination, dev/start process launch,
  stream handling, preparation scheduling, and direct-kill development restart.
- `packages/cli/src/project/scaffold/framework-renderers.ts` contains existing
  framework process launch and POSIX signal forwarding.
- `packages/cli/tests/framework-port.test.ts` covers real-process shutdown.
- `packages/cli/tests/cli.test.ts` covers development preparation and restart,
  including the current error-without-closure reload behavior.
