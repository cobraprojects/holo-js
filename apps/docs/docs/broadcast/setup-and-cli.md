# Setup And CLI

## Installation

Install broadcasting support through your package manager:

::: code-group

```bash [npm]
npx holo install broadcast
```

```bash [pnpm]
pnpm dlx holo install broadcast
```

```bash [Yarn]
yarn dlx holo install broadcast
```

```bash [Bun]
bunx holo install broadcast
```

:::

This generates:

- `config/broadcast.ts`
- `server/broadcast/`
- `server/channels/`
- `/broadcasting/config` route integration
- `/broadcasting/auth` route integration
- framework Flux package dependency (`@holo-js/flux-react`, `@holo-js/flux-vue`, or `@holo-js/flux-svelte`)

Next.js receives generated public route files for `/broadcasting/config` and `/broadcasting/auth`.
Nuxt and SvelteKit receive internal framework route integration for the same URLs.
User code does not create or import these routes directly.

## File Generation

```bash
npx holo make:broadcast orders/shipment-updated
npx holo make:channel orders.{orderId}
```

## Running The Worker

::: code-group

```bash [npm]
npx holo broadcast:work
```

```bash [pnpm]
pnpm dlx holo broadcast:work
```

```bash [Yarn]
yarn dlx holo broadcast:work
```

```bash [Bun]
bunx holo broadcast:work
```

:::

`broadcast:work` is required for the self-hosted `holo` driver.
Hosted providers do not require this local worker.

Runtime support:
- Bun: uses Bun websocket server path.
- Node: uses Node HTTP + websocket path.

## Minimal Verification

1. Install broadcast.
2. Add channel authorize callbacks in `server/channels`.
3. Add event factories in `server/broadcast`.
4. Dispatch one event from server code.
5. Subscribe from UI using Flux.
6. Confirm worker is running for `holo`.
