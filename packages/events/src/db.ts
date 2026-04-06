import { connectionAsyncContext } from '@holo-js/db'
import type { EventDeferredDispatchContext } from './contracts'

export function deferEventDispatchToDatabaseCommit(
  callback: () => Promise<void>,
  _context: EventDeferredDispatchContext,
): boolean {
  const active = connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return false
  }

  active.afterCommit(callback)
  return true
}
