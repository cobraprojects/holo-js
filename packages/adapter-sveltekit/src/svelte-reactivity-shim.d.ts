declare module 'svelte/reactivity' {
  export function createSubscriber(
    start: (update: () => void) => void | (() => void),
  ): () => void
}
