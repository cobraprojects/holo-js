import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRecord, SessionStore } from '../contracts'

function serializeRecord(record: SessionRecord): string {
  return JSON.stringify({
    ...record,
    createdAt: record.createdAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  })
}

function deserializeRecord(raw: string): SessionRecord {
  const parsed = JSON.parse(raw) as Omit<SessionRecord, 'createdAt' | 'lastActivityAt' | 'expiresAt'> & {
    createdAt: string
    lastActivityAt: string
    expiresAt: string
  }
  return Object.freeze({
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    lastActivityAt: new Date(parsed.lastActivityAt),
    expiresAt: new Date(parsed.expiresAt),
  })
}

function getRecordPath(root: string, sessionId: string): string {
  return join(root, `${encodeURIComponent(sessionId)}.json`)
}

export function createFileSessionStore(root: string): SessionStore {
  return {
    async read(sessionId) {
      const contents = await readFile(getRecordPath(root, sessionId), 'utf8').catch(() => undefined)
      return contents ? deserializeRecord(contents) : null
    },
    async write(record) {
      await mkdir(root, { recursive: true })
      await writeFile(getRecordPath(root, record.id), serializeRecord(record), 'utf8')
    },
    async delete(sessionId) {
      await rm(getRecordPath(root, sessionId), { force: true })
    },
  }
}

export const fileSessionDriverInternals = {
  deserializeRecord,
  getRecordPath,
  serializeRecord,
}
