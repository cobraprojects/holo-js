import type {
  MutableRealtimeQueryStore,
  RealtimeClientState,
} from './types'

export function getRealtimeClientState(): RealtimeClientState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeClient__?: RealtimeClientState
  }

  runtime.__holoRealtimeClient__ ??= {
    stores: new Map<string, MutableRealtimeQueryStore<unknown>>(),
    warnedMessages: new Set<string>(),
  }
  return runtime.__holoRealtimeClient__
}
