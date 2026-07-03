import type { RealtimeRuntimeBindings } from '../contracts'
import { getRuntimeState } from './state'

export function configureRealtimeRuntime(bindings?: RealtimeRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function resetRealtimeRuntime(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase?.()
  if (state.invalidationBatch) {
    clearTimeout(state.invalidationBatch.timer)
    state.invalidationBatch.deferred.resolve(undefined)
  }
  state.bindings = undefined
  state.dependencySubscribers.clear()
  state.invalidationBatch = undefined
  state.nextSubscriptionId = 0
  state.queryEntries.clear()
  state.unsubscribeFromDatabase = undefined
  state.refreshes.clear()
  state.tableBroadSubscribers.clear()
  state.tablePredicateColumnSubscribers.clear()
  state.tablePredicateValueSubscribers.clear()
  state.subscriptions.clear()
}
