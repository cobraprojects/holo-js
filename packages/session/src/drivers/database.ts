import type { SessionRecord, SessionStore, SessionStoreTakeResult } from '../contracts'

export interface SessionDatabaseDriverAdapter {
  read(sessionId: string): Promise<SessionRecord | null>
  write(record: SessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
  rotate?(previousSessionId: string, record: SessionRecord): Promise<void>
  flash?(sessionId: string, key: string, value: unknown): Promise<void>
  take?(sessionId: string, key: string): Promise<SessionStoreTakeResult>
}

export function createDatabaseSessionStore(adapter: SessionDatabaseDriverAdapter): SessionStore {
  const rotate = adapter.rotate?.bind(adapter)
  const flash = adapter.flash?.bind(adapter)
  const take = adapter.take?.bind(adapter)

  return {
    read(sessionId) {
      return adapter.read(sessionId)
    },
    write(record) {
      return adapter.write(record)
    },
    delete(sessionId) {
      return adapter.delete(sessionId)
    },
    ...(rotate ? { rotate } : {}),
    ...(flash ? { flash } : {}),
    ...(take ? { take } : {}),
  }
}
