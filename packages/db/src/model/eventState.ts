import { AsyncLocalStorage } from 'node:async_hooks'

const eventMuteStorage = new AsyncLocalStorage<number>()
const guardBypassStorage = new AsyncLocalStorage<number>()

export function areModelEventsMuted(): boolean {
  return (eventMuteStorage.getStore() ?? 0) > 0
}

export async function withoutModelEvents<T>(callback: () => T | Promise<T>): Promise<T> {
  const depth = eventMuteStorage.getStore() ?? 0
  return eventMuteStorage.run(depth + 1, callback)
}

export function areModelGuardsDisabled(): boolean {
  return (guardBypassStorage.getStore() ?? 0) > 0
}

export async function withoutModelGuards<T>(callback: () => T | Promise<T>): Promise<T> {
  const depth = guardBypassStorage.getStore() ?? 0
  return guardBypassStorage.run(depth + 1, callback)
}
