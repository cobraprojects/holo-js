# Setup And CLI

Events are first-class in new Holo-JS projects.

## Discovery directories

Holo-JS discovers events and listeners recursively from:

- `server/events`
- `server/listeners`

Subfolders are supported.

Examples:

```text
server/events/user/registered.ts
server/events/billing/invoice-paid.ts
server/listeners/user/send-welcome-email.ts
server/listeners/billing/sync-invoice-state.ts
```

## Scaffolding commands

Create an event:

```bash
npx holo make:event user/registered
```

Create a listener for one event:

```bash
npx holo make:listener user/send-welcome-email --event user.registered
```

Create a listener for multiple events:

```bash
npx holo make:listener audit/user-lifecycle \
  --event user.registered \
  --event user.deleted
```

## Existing projects

Install event support into an existing Holo-JS app with:

```bash
npx holo install events
```

This adds the `@holo-js/events` package dependency when needed and creates the discovery directories:

- `server/events`
- `server/listeners`

After install, run normal discovery through `holo dev`, `holo build`, or `holo prepare`.

## Generated metadata

Discovery output is written under `.holo-js/generated`, including event and listener registries and type
augmentation for `@holo-js/events`.

Runtime boot reads generated metadata. It does not scan files directly at runtime.

## Continue

- [Defining Events](/events/defining-events)
- [Defining Listeners](/events/defining-listeners)
