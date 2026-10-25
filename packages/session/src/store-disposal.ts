import { reportError } from '@holo-js/kernel/error-reporting'
import type { SessionStore } from './contracts'

export const SESSION_STORE_DISPOSE_SYMBOL = Symbol.for('holo.session.store.dispose')

export type DisposableSessionStore = SessionStore & {
  readonly [SESSION_STORE_DISPOSE_SYMBOL]?: () => Promise<void>
}

export function disposeSessionStore(store: SessionStore): void {
  const reportFailure = (error: unknown): void => reportError(error, { capability: 'session', operation: 'store.dispose' })
  try {
    void Promise.resolve((store as DisposableSessionStore)[SESSION_STORE_DISPOSE_SYMBOL]?.()).catch(reportFailure)
  } catch (error) {
    reportFailure(error)
  }
}
