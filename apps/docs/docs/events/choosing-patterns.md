# Choosing Patterns

Use this guide when deciding between sync listeners, queued listeners, queue jobs, and direct service calls.

## Sync listeners

Use when:

- side effect is quick
- side effect should be in the same request flow
- you want deterministic inline ordering

Avoid when:

- side effect is slow or remote-heavy
- work should survive process restarts

## Queued listeners

Use when:

- reaction belongs to an event contract
- work can run asynchronously
- you still want event fan-out semantics

Good examples:

- welcome emails
- analytics fan-out
- projection updates

## Queue jobs

Use when:

- the work unit itself is primary (not event fan-out)
- you want explicit operational control over one job contract

Good examples:

- nightly report generation
- media batch processing
- explicit maintenance tasks

## Direct service calls

Use when:

- behavior is request-local and tightly coupled
- no pub/sub style decoupling is needed

Direct calls keep code simple when no fan-out is required.

## Practical decision rule

- one caller, one action, strongly coupled: direct call
- one signal, many reactions: event + listeners
- reaction should be async: queued listener
- standalone async work contract: queue job

## Continue

- [Events](/events/)
- [Queued Listeners](/events/queued-listeners)
- [Queue Jobs](/queue/jobs)
