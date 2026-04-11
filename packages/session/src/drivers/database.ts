import type { SessionRecord, SessionStore } from '../contracts'

export interface SessionDatabaseDriverAdapter {
  read(sessionId: string): Promise<SessionRecord | null>
  write(record: SessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
}

export function createDatabaseSessionStore(adapter: SessionDatabaseDriverAdapter): SessionStore {
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
  }
}
