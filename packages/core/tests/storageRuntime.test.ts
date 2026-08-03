import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const tempDirs: string[] = []

async function withoutVitestEnv<T>(callback: () => Promise<T>): Promise<T> {
  const originalVitest = process.env.VITEST
  delete process.env.VITEST

  try {
    return await callback()
  } finally {
    if (typeof originalVitest === 'string') {
      process.env.VITEST = originalVitest
    } else {
      delete process.env.VITEST
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createSymlinkedStorageDirectory(): Promise<{
  readonly backend: ReturnType<typeof storageRuntimeInternals.createFileStorageBackend>
  readonly outside: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'holo-storage-symlink-'))
  tempDirs.push(root)
  const storage = join(root, 'storage')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(storage), mkdir(outside)])
  await symlink(outside, join(storage, 'escape'))
  return {
    backend: storageRuntimeInternals.createFileStorageBackend(storage),
    outside,
  }
}

describe('@holo-js/core storage runtime optional imports', () => {
  it('rejects streamed writes through a symlinked storage parent', async () => {
    const { backend, outside } = await createSymlinkedStorageDirectory()
    if (!backend.setItemStream) throw new Error('The file storage backend must support streamed writes.')
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('private')
    })()

    await expect(backend.setItemStream('escape:private.txt', source, { overwrite: true })).rejects.toThrow(
      'Storage paths must stay inside the configured disk root',
    )
    await expect(readFile(join(outside, 'private.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects paginated listings through a symlinked storage directory', async () => {
    const { backend, outside } = await createSymlinkedStorageDirectory()
    if (!backend.getKeysPage) throw new Error('The file storage backend must support paginated listings.')
    await writeFile(join(outside, 'private.txt'), 'private')

    await expect(backend.getKeysPage('escape:', { cursor: null, limit: 10 })).rejects.toThrow(
      'Storage paths must stay inside the configured disk root',
    )
  })

  it('resets the storage runtime through the dynamic loader', async () => {
    const resetStorageRuntime = vi.fn()
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockResolvedValueOnce({
      resetStorageRuntime,
    })

    await resetOptionalStorageRuntime()

    expect(resetStorageRuntime).toHaveBeenCalledTimes(1)
  })

  it('treats missing storage runtime modules as optional during reset', async () => {
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockResolvedValueOnce(undefined)
    await expect(resetOptionalStorageRuntime()).resolves.toBeUndefined()
  })

  it('rethrows non-missing storage runtime import failures during reset', async () => {
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockRejectedValueOnce(new Error('boom'))
    await expect(resetOptionalStorageRuntime()).rejects.toThrow('boom')
  })

  it('rethrows non-object optional storage runtime import failures during reset', async () => {
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockRejectedValueOnce('boom')
    await expect(resetOptionalStorageRuntime()).rejects.toBe('boom')
  })

  it('imports optional storage modules through the shared optional runtime loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-'))
    tempDirs.push(root)
    const modulePath = join(root, 'module.mjs')
    await writeFile(modulePath, 'export default "loaded"\n', 'utf8')

    await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).resolves.toEqual(
      expect.objectContaining({
        default: 'loaded',
      }),
    )
  })

  it('treats missing optional storage modules as optional inside Vitest as well', async () => {
    await expect(storageRuntimeInternals.importOptionalModule('./definitely-missing-storage-runtime.mjs')).resolves.toBeUndefined()
  })

  it('treats missing optional bare packages as optional outside Vitest', async () => {
    await withoutVitestEnv(async () => {
      await expect(storageRuntimeInternals.importOptionalModule('@holo-js/definitely-missing-storage-runtime')).resolves.toBeUndefined()
    })
  })

  it('rethrows module evaluation failures outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-boom-'))
    tempDirs.push(root)
    const modulePath = join(root, 'boom.mjs')
    await writeFile(modulePath, 'throw new Error("boom")\n', 'utf8')

    await withoutVitestEnv(async () => {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toThrow('boom')
    })
  })

  it('does not treat unrelated "Failed to load url" failures as missing modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-failed-url-'))
    tempDirs.push(root)
    const modulePath = join(root, 'broken.mjs')
    await writeFile(modulePath, `throw new Error(${JSON.stringify(`Failed to load url ${pathToFileURL(modulePath).href} (syntax error)`)})\n`, 'utf8')
    await withoutVitestEnv(async () => {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toThrow('Failed to load url')
    })
  })

  it('returns undefined for missing optional storage modules outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-missing-'))
    tempDirs.push(root)
    await withoutVitestEnv(async () => {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(join(root, 'missing.mjs')).href)).resolves.toBeUndefined()
    })
  })

  it('retries partial stream writes until the complete chunk is persisted', async () => {
    const offsets: number[] = []
    const handle = {
      async write(_buffer: Uint8Array, offset: number, length: number) {
        offsets.push(offset)
        return { bytesWritten: Math.min(2, length) }
      },
    }

    await storageRuntimeInternals.writeCompleteChunk(handle, new Uint8Array(5))
    expect(offsets).toEqual([0, 2, 4])
    await expect(storageRuntimeInternals.writeCompleteChunk({
      async write() {
        return { bytesWritten: 0 }
      },
    }, new Uint8Array(1))).rejects.toThrow('made no progress')
  })

})
