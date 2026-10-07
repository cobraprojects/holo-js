# Keep SvelteKit validation handling inside the request lifecycle

The SvelteKit adapter will own validation capture, response mapping, and cleanup for each originating request, while generated hooks retain routing, authorization, and native composition. We chose a native hook-pair factory because SvelteKit invokes request handling and error handling through separate hooks; a request-handler-only interface cannot encapsulate both. Method-and-URL correlation is removed, and native redirect, response, and cookie behavior is preserved.

Approved export from `@holo-js/adapter-sveltekit`:

```ts
createSvelteKitHoloHooks(hooks: {
  readonly handle: Handle
  readonly handleError?: HandleServerError
}): {
  readonly handle: Handle
  readonly handleError: HandleServerError
}
```

`Handle` and `HandleServerError` are native SvelteKit types. The existing generic `runWithSvelteKitRequestEvent` interface remains unchanged. The factory is implemented in the SvelteKit adapter.

Verification must cover overlapping requests to the same URL, native tracing event clones that preserve request identity, HTML and JSON action responses, ordinary error-hook delegation, and cleanup on failure. Fatal errors reported after the request handler unwinds must not leave retained validation payloads or assume an active request scope.
