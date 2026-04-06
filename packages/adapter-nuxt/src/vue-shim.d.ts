declare module 'vue' {
  export function onScopeDispose(callback: () => void): void
  export function shallowRef<TValue>(value: TValue): { value: TValue }
  export function watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void): () => void
}
