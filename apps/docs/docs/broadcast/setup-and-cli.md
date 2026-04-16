# Setup And CLI

## Installation

Install broadcasting support:

```bash
holo install broadcast
```

If `holo` is not installed globally, run it through your package manager:

```bash
npx holo install broadcast
pnpm dlx holo install broadcast
yarn dlx holo install broadcast
bunx holo install broadcast
```

This generates:

- `config/broadcast.ts`
- `server/broadcast/`
- `server/channels/`
- `/broadcasting/auth` route scaffold
- framework Flux package dependency (`@holo-js/flux-react`, `@holo-js/flux-vue`, or `@holo-js/flux-svelte`)

## File Generation

```bash
holo make:broadcast orders/shipment-updated
holo make:channel orders.{orderId}
```

## Running The Worker

```bash
holo broadcast:work
```

Or via package manager:

```bash
npx holo broadcast:work
pnpm dlx holo broadcast:work
yarn dlx holo broadcast:work
bunx holo broadcast:work
```

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
