import type { SessionDataUpdate, SessionRecord, SessionStore, SessionStoreSetDataResult, SessionStoreTakeResult, SessionStoreTouchOptions, SessionStoreUpdateDataResult } from '../contracts'

export interface SessionDatabaseDriverAdapter {
  touch?(sessionId: string, options: SessionStoreTouchOptions): Promise<SessionRecord | null>
  read(sessionId: string): Promise<SessionRecord | null>
  write(record: SessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
  rotate?(previousSessionId: string, record: SessionRecord, update?: SessionDataUpdate): Promise<void>
  flash?(sessionId: string, key: string, value: unknown): Promise<void>
  take?(sessionId: string, key: string): Promise<SessionStoreTakeResult>
  setDataIfAbsent?(sessionId: string, key: string, value: unknown): Promise<SessionStoreSetDataResult>
  updateData?(sessionId: string, key: string, update: (current: unknown) => unknown): Promise<SessionStoreUpdateDataResult>
  sweepExpired?(now: Date): Promise<number>
}

export function createDatabaseSessionStore(adapter: SessionDatabaseDriverAdapter): SessionStore {
  const touch = adapter.touch?.bind(adapter)
  const rotate = adapter.rotate?.bind(adapter)
  const flash = adapter.flash?.bind(adapter)
  const take = adapter.take?.bind(adapter)
  const setDataIfAbsent = adapter.setDataIfAbsent?.bind(adapter)
  const updateData = adapter.updateData?.bind(adapter)
  const sweepExpired = adapter.sweepExpired?.bind(adapter)

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
    ...(touch ? { touch } : {}),
    ...(rotate ? { rotate } : {}),
    ...(flash ? { flash } : {}),
    ...(take ? { take } : {}),
    ...(setDataIfAbsent ? { setDataIfAbsent } : {}),
    ...(updateData ? { updateData } : {}),
    ...(sweepExpired ? { sweepExpired } : {}),
  }
}
