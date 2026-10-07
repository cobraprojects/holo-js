# Keep request-context ownership framework-specific

Each framework will have one request-context owner shared by its auth integration and framework adapter, while auth remains independently usable. We chose framework-specific ownership over a universal context module because native request access and supported runtimes differ. Shared behavior must be demonstrated before it is extracted; native redirect, navigation, and cookie behavior stays with each framework integration.

Next auth retains standalone and Edge support. Where native request mechanisms cannot provide safe asynchronous isolation, the integration must report an explicit error rather than use shared mutable request state.

The canonical stores will live in framework-specific entry points in the existing `@holo-js/adapter-shared` package. Auth and adapter exports retain their current names and behavior while using these stores; framework-specific auth accessor integration remains with the adapter.

Approved exports from `@holo-js/adapter-shared/next/request-context`:

```ts
getCurrentNextRequest(): NextRequestLike | undefined
runWithNextRequest<TValue>(
  request: NextRequestLike,
  callback: () => TValue,
): TValue
```

Approved exports from `@holo-js/adapter-shared/sveltekit/request-context`:

```ts
getCurrentSvelteKitRequestEvent(): SvelteKitRequestEvent | undefined
runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitRequestEvent,
  callback: () => TValue,
): TValue
```

The request types retain the existing structural shapes. These entry points are implemented in the shared adapter package.
