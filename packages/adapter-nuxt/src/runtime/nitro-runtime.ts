import type { createNuxtAuthorizationError } from './authorization-error'
import type { NuxtAuthRequestEvent } from './composables'

export type NuxtRuntime = {
  readonly useEvent: () => NuxtAuthRequestEvent | undefined
  readonly createAuthorizationError: typeof createNuxtAuthorizationError
}

type RuntimeGlobals = typeof globalThis & {
  __holoNuxtRuntime?: NuxtRuntime
}

export function configureNuxtRuntime(runtime: NuxtRuntime): void {
  const globals = globalThis as RuntimeGlobals
  globals.__holoNuxtRuntime = runtime
}

export function getNuxtRuntime(): NuxtRuntime {
  const runtime = (globalThis as RuntimeGlobals).__holoNuxtRuntime
  if (!runtime) throw new TypeError('Holo Nuxt runtime is not configured.')
  return runtime
}
