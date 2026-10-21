import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileRateLimitStore, fileRateLimitDriverInternals } from '../src'

const faults = vi.hoisted(() => ({
  unreadableDirectory: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const readdir = (...args: Parameters<typeof actual.readdir>) => {
    if (faults.unreadableDirectory !== undefined && String(args[0]) === faults.unreadableDirectory) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${String(args[0])}'`), { code: 'EACCES' }))
    }

    return (actual.readdir as (...values: Parameters<typeof actual.readdir>) => Promise<unknown>)(...args)
  }

  return {
    ...actual,
    readdir: readdir as typeof actual.readdir,
  }
})

const tempDirs: string[] = []
const sweepStart = new Date('2026-04-16T12:00:00.000Z')

afterEach(async () => {
  faults.unreadableDirectory = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function writeExpiredBucket(root: string, key: string) {
  const path = fileRateLimitDriverInternals.getBucketPath(root, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    namespaceHash: 'namespace',
    keyHash: fileRateLimitDriverInternals.createBucketHash(key),
    prefixHashes: ['prefix'],
    attempts: 1,
    expiresAt: '2026-04-16T11:59:00.000Z',
  }), 'utf8')
}

async function waitUntil(predicate: () => Promise<boolean>) {
  await vi.waitFor(async () => {
    if (!(await predicate())) {
      throw new Error('Timed out waiting for the background sweep.')
    }
  }, { timeout: 60_000, interval: 10 })
}

describe('file sweep with an unreadable bucket shard', () => {
  it('keeps sweeping past an injected EACCES shard and reports it once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
    tempDirs.push(root)
    const probe = (index: number) => `limiter:login|user:probe-${index}`
    const topOf = (key: string) => fileRateLimitDriverInternals.createBucketHash(key).slice(0, 2)

    const unreadableKey = probe(0)
    const unreadableTop = topOf(unreadableKey)
    let healthyKey = ''
    for (let index = 1; healthyKey === ''; index += 1) {
      if (topOf(probe(index)) > unreadableTop) {
        healthyKey = probe(index)
      }
    }
    let kickerIndex = 0
    while (topOf(probe(kickerIndex)) === unreadableTop || topOf(probe(kickerIndex)) === topOf(healthyKey)) {
      kickerIndex += 1
    }
    const kicker = probe(kickerIndex)

    await writeExpiredBucket(root, unreadableKey)
    await writeExpiredBucket(root, healthyKey)
    const healthyPath = fileRateLimitDriverInternals.getBucketPath(root, healthyKey)
    faults.unreadableDirectory = dirname(dirname(fileRateLimitDriverInternals.getBucketPath(root, unreadableKey)))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      let now = sweepStart
      const store = createFileRateLimitStore(root, { now: () => now })

      await expect(store.hit(kicker, { maxAttempts: 2, decaySeconds: 60 })).resolves.toMatchObject({
        limited: false,
        snapshot: { attempts: 1 },
      })

      await waitUntil(async () => {
        await store.hit(kicker, { maxAttempts: 2, decaySeconds: 60 })
        return await access(healthyPath).then(() => false, () => true)
      })

      now = new Date(now.getTime() + 61_000)
      await waitUntil(async () => {
        await store.hit(kicker, { maxAttempts: 2, decaySeconds: 60 })
        return fileRateLimitDriverInternals.sweepRunsStarted(store) >= 2 && !fileRateLimitDriverInternals.sweepInFlight(store)
      })

      const unreadableReports = consoleError.mock.calls.filter(call => String(call[0]).includes('rate-limit expired-bucket sweep'))
      expect(unreadableReports).toHaveLength(1)
      expect(String(unreadableReports[0]?.[1])).toContain('EACCES')
      await store.close?.()
    } finally {
      consoleError.mockRestore()
    }
  }, 120_000)
})
