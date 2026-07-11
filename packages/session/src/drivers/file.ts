import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, delayMs))
}

async function acquireRecordLock(recordPath: string): Promise<() => Promise<void>> {
  const lockPath = `${recordPath}.lock`
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await mkdir(lockPath)
      return async () => rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException
      if (candidate.code !== 'EEXIST') {
        throw error
      }
      const stale = await stat(lockPath).then(value => value.mtimeMs <= Date.now() - 10_000).catch(() => false)
      if (stale) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`[@holo-js/session] Timed out acquiring file session lock for "${recordPath}".`)
      }
      await sleep(5)
    }
  }
}

async function writeRecordAtomically(root: string, record: SessionRecord): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const recordPath = getRecordPath(root, record.id)
  const release = await acquireRecordLock(recordPath)
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, serializeRecord(record), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, recordPath)
  } finally {
    await rm(temporaryPath, { force: true })
    await release()
  }
}

export function createFileSessionStore(root: string): SessionStore {
  return {
    async read(sessionId) {
      try {
        return deserializeRecord(await readFile(getRecordPath(root, sessionId), 'utf8'))
      } catch (error) {
        if (isMissingFileError(error)) {
          return null
        }

        throw error
      }
    },
    async write(record) {
      await writeRecordAtomically(root, record)
    },
    async delete(sessionId) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, sessionId)
      const release = await acquireRecordLock(recordPath)
      try {
        await rm(recordPath, { force: true })
      } finally {
        await release()
      }
    },
  }
}

export const fileSessionDriverInternals = {
  deserializeRecord,
  getRecordPath,
  serializeRecord,
  writeRecordAtomically,
}
