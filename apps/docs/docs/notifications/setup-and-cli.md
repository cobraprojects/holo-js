# Setup And CLI

Notifications are optional. Add them during scaffold if the project needs notification delivery on day one, or
install them later into an existing project.

## Scaffold during project creation

Use the optional package flag during `create`:

```bash
npm create holo-js@latest my-app -- --package notifications
```

Multiple optional packages still compose normally:

```bash
npm create holo-js@latest my-app -- --package forms,validation,notifications
```

## Existing projects

Install notifications into an existing Holo-JS app with:

```bash
npx holo install notifications
```

This adds the `@holo-js/notifications` package dependency when needed and scaffolds:

- `config/notifications.ts`
- a `create_notifications` migration

After install, run the normal migration flow:

```bash
npx holo migrate
```

## Scaffolded database channel support

The notifications migration creates the default table for the built-in `database` channel. If the app only uses
email or broadcast notifications, the table can remain unused.

The default row shape is:

- `id`
- `type`
- `notifiable_type`
- `notifiable_id`
- `data`
- `read_at`
- `created_at`
- `updated_at`

## Runtime contracts

Built-in channels are present immediately:

- `email`
- `database`
- `broadcast`

`database` works through the default store that core configures. `email` and `broadcast` require runtime sender
bindings because this package does not ship SMTP or websocket transports.

## Auth integration

When both `@holo-js/auth` and `@holo-js/notifications` are installed, core can route auth delivery through
notifications automatically:

- email verification
- password reset

Auth still owns token creation and validation. Notifications only own delivery.

## Continue

- [Notifications Overview](/notifications/)
- [Sending Notifications](/notifications/sending-notifications)
