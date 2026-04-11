import type { SessionRecord, SessionStore } from '../contracts'

export interface SessionRedisDriverAdapter {
  get(sessionId: string): Promise<SessionRecord | null>
  set(record: SessionRecord): Promise<void>
  del(sessionId: string): Promise<void>
}

export function createRedisSessionStore(adapter: SessionRedisDriverAdapter): SessionStore {
  return {
    read(sessionId) {
      return adapter.get(sessionId)
    },
    write(record) {
      return adapter.set(record)
    },
    delete(sessionId) {
      return adapter.del(sessionId)
    },
  }
}
