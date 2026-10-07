export interface HoloRuntimeState<TRuntime, TSecurityRedisAdapter, TSessionRedisAdapter> {
  current?: TRuntime
  pending?: Promise<TRuntime>
  pendingProjectRoot?: string
  securityRedisAdapter?: TSecurityRedisAdapter
  securityRateLimitStore?: { close?(): void | Promise<void> }
  sessionRuntimeBindings?: object
  sessionRedisAdapters?: readonly TSessionRedisAdapter[]
}

export type OptionalSubsystemRuntimeBindings = Readonly<{
  readonly liveBindings: ReadonlyMap<string, unknown>
  readonly mail?: unknown
  readonly notifications?: unknown
  readonly broadcast?: unknown
  readonly security?: { readonly rateLimitStore?: unknown }
}>

type OptionalRuntimeGlobals = typeof globalThis & {
  __holoMailRuntime__?: { bindings?: unknown }
  __holoNotificationsRuntime__?: { bindings?: unknown }
  __holoBroadcastRuntime__?: { bindings?: unknown }
  __holoSecurityRuntime__?: { bindings?: { readonly rateLimitStore?: unknown } }
}

export function createRuntimeStateAccessors<TRuntime, TSecurityRedisAdapter, TSessionRedisAdapter>(): {
  getRuntimeState(): HoloRuntimeState<TRuntime, TSecurityRedisAdapter, TSessionRedisAdapter>
  snapshotOptionalSubsystemRuntimeBindings(): OptionalSubsystemRuntimeBindings
  restoreOptionalSubsystemRuntimeBindings(
    bindings: OptionalSubsystemRuntimeBindings,
  ): void
} {
  const getRuntimeState = (): HoloRuntimeState<TRuntime, TSecurityRedisAdapter, TSessionRedisAdapter> => {
    const runtime = globalThis as typeof globalThis & {
      __holoRuntime__?: HoloRuntimeState<TRuntime, TSecurityRedisAdapter, TSessionRedisAdapter>
    }
    runtime.__holoRuntime__ ??= {}
    return runtime.__holoRuntime__
  }

  const snapshotOptionalSubsystemRuntimeBindings = (): OptionalSubsystemRuntimeBindings => {
    const state = getRuntimeState()
    const runtime = globalThis as OptionalRuntimeGlobals
    const host = globalThis as typeof globalThis & Record<string, unknown>
    const liveBindings = new Map<string, unknown>()
    const sessionState = host.__holoSessionRuntime__ as { bindings?: object } | undefined
    for (const key of [
      '__holoAuthRuntime__', '__holoSessionRuntime__', '__holoQueueRuntime__',
      '__holoCacheRuntime__', '__holoCacheQueryBridge__', '__holoDbQueryCacheBridge__',
      '__holoAuthorizationRuntime__',
      '__holoJsAuthWorkosRuntime', '__holoJsAuthClerkRuntime', '__holoAuthSocialBindings__',
      '__holoStorageRuntimeBindings__',
    ]) {
      const value = key === '__holoSessionRuntime__' && sessionState?.bindings === state.sessionRuntimeBindings
        ? undefined
        : host[key]
      liveBindings.set(key, value && typeof value === 'object' ? { ...value } : value)
    }
    return Object.freeze({
      liveBindings,
      ...(runtime.__holoMailRuntime__?.bindings ? { mail: runtime.__holoMailRuntime__.bindings } : {}),
      ...(runtime.__holoNotificationsRuntime__?.bindings
        ? { notifications: runtime.__holoNotificationsRuntime__.bindings }
        : {}),
      ...(runtime.__holoBroadcastRuntime__?.bindings
        ? { broadcast: runtime.__holoBroadcastRuntime__.bindings }
        : {}),
      ...(!state.securityRateLimitStore || runtime.__holoSecurityRuntime__?.bindings?.rateLimitStore !== state.securityRateLimitStore
        ? { security: runtime.__holoSecurityRuntime__?.bindings }
        : {}),
    })
  }

  const restoreOptionalSubsystemRuntimeBindings = (
    bindings: OptionalSubsystemRuntimeBindings,
  ): void => {
    const state = getRuntimeState()
    const runtime = globalThis as OptionalRuntimeGlobals
    const host = globalThis as typeof globalThis & Record<string, unknown>
    for (const [key, value] of bindings.liveBindings) {
      if (typeof value === 'undefined') delete host[key]
      else host[key] = value
    }

    if (bindings.mail || runtime.__holoMailRuntime__) {
      runtime.__holoMailRuntime__ ??= {}
      runtime.__holoMailRuntime__.bindings = bindings.mail
    }
    if (bindings.notifications || runtime.__holoNotificationsRuntime__) {
      runtime.__holoNotificationsRuntime__ ??= {}
      runtime.__holoNotificationsRuntime__.bindings = bindings.notifications
    }
    if (bindings.broadcast || runtime.__holoBroadcastRuntime__) {
      runtime.__holoBroadcastRuntime__ ??= {}
      runtime.__holoBroadcastRuntime__.bindings = bindings.broadcast
    }

    state.sessionRedisAdapters = undefined
    state.sessionRuntimeBindings = undefined
    state.securityRateLimitStore = undefined

    if (bindings.security || runtime.__holoSecurityRuntime__) {
      runtime.__holoSecurityRuntime__ ??= {}
      runtime.__holoSecurityRuntime__.bindings = bindings.security
      state.securityRedisAdapter = undefined
    }
  }

  return {
    getRuntimeState,
    restoreOptionalSubsystemRuntimeBindings,
    snapshotOptionalSubsystemRuntimeBindings,
  }
}
