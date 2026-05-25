declare module '$app/stores' {
  import type { Readable } from 'svelte/store'

  export const page: Readable<{
    readonly form: unknown
  }>
}
