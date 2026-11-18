import { AsyncLocalStorage } from 'node:async_hooks'

const queryLoggerScope = new AsyncLocalStorage<true>()

export function isEmittingQueryLog(): boolean {
  return queryLoggerScope.getStore() === true
}

export async function emitQueryLog(emit: () => void | Promise<void>): Promise<void> {
  if (isEmittingQueryLog()) return
  await queryLoggerScope.run(true, emit)
}
