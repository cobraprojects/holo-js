import type { SessionRecord, SessionStore, SessionStoreSetDataResult, SessionStoreTakeResult, SessionStoreTouchOptions } from '../contracts'

export interface SessionRedisDriverAdapter {
  touch?(sessionId: string, options: SessionStoreTouchOptions): Promise<SessionRecord | null>
  get(sessionId: string): Promise<SessionRecord | null>
  set(record: SessionRecord): Promise<void>
  del(sessionId: string): Promise<void>
  writeIfAbsent?(record: SessionRecord): Promise<boolean>
  rotate?(previousSessionId: string, record: SessionRecord): Promise<void>
  flash?(sessionId: string, key: string, value: unknown): Promise<void>
  take?(sessionId: string, key: string): Promise<SessionStoreTakeResult>
  setDataIfAbsent?(sessionId: string, key: string, value: unknown): Promise<SessionStoreSetDataResult>
}

export function createRedisSessionStore(adapter: SessionRedisDriverAdapter): SessionStore {
  const writeIfAbsent = adapter.writeIfAbsent?.bind(adapter)
  const touch = adapter.touch?.bind(adapter)
  const rotate = adapter.rotate?.bind(adapter)
  const flash = adapter.flash?.bind(adapter)
  const take = adapter.take?.bind(adapter)
  const setDataIfAbsent = adapter.setDataIfAbsent?.bind(adapter)

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
    ...(writeIfAbsent ? { writeIfAbsent } : {}),
    ...(touch ? { touch } : {}),
    ...(rotate ? { rotate } : {}),
    ...(flash ? { flash } : {}),
    ...(take ? { take } : {}),
    ...(setDataIfAbsent ? { setDataIfAbsent } : {}),
  }
}
