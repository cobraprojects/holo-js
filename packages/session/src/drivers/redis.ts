import type { SessionRecord, SessionStore, SessionStoreTakeResult } from '../contracts'

export interface SessionRedisDriverAdapter {
  get(sessionId: string): Promise<SessionRecord | null>
  set(record: SessionRecord): Promise<void>
  del(sessionId: string): Promise<void>
  rotate?(previousSessionId: string, record: SessionRecord): Promise<void>
  flash?(sessionId: string, key: string, value: unknown): Promise<void>
  take?(sessionId: string, key: string): Promise<SessionStoreTakeResult>
}

export function createRedisSessionStore(adapter: SessionRedisDriverAdapter): SessionStore {
  const rotate = adapter.rotate?.bind(adapter)
  const flash = adapter.flash?.bind(adapter)
  const take = adapter.take?.bind(adapter)

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
    ...(rotate ? { rotate } : {}),
    ...(flash ? { flash } : {}),
    ...(take ? { take } : {}),
  }
}
