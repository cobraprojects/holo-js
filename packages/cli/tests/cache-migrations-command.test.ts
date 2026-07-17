import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IoStreams } from '../src/cli-types'

type DatabaseCacheDriver = {
  readonly driver: 'database'
  readonly table: string
  readonly lockTable: string
}

type CacheConfig = {
  readonly drivers: Record<string, DatabaseCacheDriver>
}

type RunCacheTableCommand = (io: IoStreams, projectRoot: string) => Promise<void>

function createIo(): IoStreams {
  return {
    cwd: '/project',
    stdin: Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream,
    stdout: Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream,
    stderr: Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream,
  }
}

async function loadCacheTableCommand(cacheConfig: CacheConfig): Promise<{
  readonly runCacheTableCommand: RunCacheTableCommand
  readonly runProjectPrepare: ReturnType<typeof vi.fn>
  readonly writeTextFile: ReturnType<typeof vi.fn>
}> {
  const runProjectPrepare = vi.fn(async () => {})
  const writeTextFile = vi.fn(async () => {})

  vi.doMock('@holo-js/config', () => ({
    loadConfigDirectory: vi.fn(async () => ({
      cache: cacheConfig,
    })),
    registerConfigNormalizer: vi.fn(() => () => {}),
  }))
  vi.doMock('../src/dev', () => ({
    runProjectPrepare,
  }))
  vi.doMock('../src/project', () => ({
    ensureProjectConfig: vi.fn(async () => ({
      config: {
        paths: {
          migrations: 'server/db/migrations',
        },
      },
    })),
    loadGeneratedProjectRegistry: vi.fn(async () => undefined),
    makeProjectRelativePath: vi.fn((_projectRoot: string, filePath: string) => filePath),
    prepareProjectDiscovery: vi.fn(async () => undefined),
    resolveDefaultArtifactPath: vi.fn((_projectRoot: string, _migrationsPath: string, fileName: string) => fileName),
    writeTextFile,
  }))

  const { runCacheTableCommand } = await import('../src/cache-migrations')

  return {
    runCacheTableCommand,
    runProjectPrepare,
    writeTextFile,
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('cache table migration command validation', () => {
  it('rejects a database cache driver whose table and lock table are the same physical table', async () => {
    const { runCacheTableCommand, runProjectPrepare, writeTextFile } = await loadCacheTableCommand({
      drivers: {
        database: {
          driver: 'database',
          table: 'cache',
          lockTable: 'cache',
        },
      },
    })

    await expect(runCacheTableCommand(createIo(), '/project')).rejects.toThrow(
      'A migration for cache tables "cache" and "cache" already exists.',
    )
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(runProjectPrepare).not.toHaveBeenCalled()
  })

  it('rejects cache table names that collide with another driver lock table', async () => {
    const { runCacheTableCommand, runProjectPrepare, writeTextFile } = await loadCacheTableCommand({
      drivers: {
        first: {
          driver: 'database',
          table: 'cache',
          lockTable: 'locks',
        },
        second: {
          driver: 'database',
          table: 'locks',
          lockTable: 'other_locks',
        },
      },
    })

    await expect(runCacheTableCommand(createIo(), '/project')).rejects.toThrow(
      'A migration for cache tables "locks" and "other_locks" already exists.',
    )
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(runProjectPrepare).not.toHaveBeenCalled()
  })
})
