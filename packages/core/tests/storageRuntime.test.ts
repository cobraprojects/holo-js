import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('@holo-js/core storage runtime optional imports', () => {
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

  it('imports optional storage modules through the webpackIgnore branch outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-'))
    tempDirs.push(root)
    const modulePath = join(root, 'module.mjs')
    await writeFile(modulePath, 'export default "loaded"\n', 'utf8')

    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).resolves.toEqual(
        expect.objectContaining({
          default: 'loaded',
        }),
      )
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('treats missing optional storage modules as optional inside Vitest as well', async () => {
    await expect(storageRuntimeInternals.importOptionalModule('./definitely-missing-storage-runtime.mjs')).resolves.toBeUndefined()
  })

  it('rethrows module evaluation failures outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-boom-'))
    tempDirs.push(root)
    const modulePath = join(root, 'boom.mjs')
    await writeFile(modulePath, 'throw new Error("boom")\n', 'utf8')

    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toThrow('boom')
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('rethrows module evaluation failures with a non-matching error code outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-code-boom-'))
    tempDirs.push(root)
    const modulePath = join(root, 'code-boom.mjs')
    await writeFile(modulePath, 'throw Object.assign(new Error("boom"), { code: "E_CUSTOM" })\n', 'utf8')

    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toThrow('boom')
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('rethrows module evaluation failures without an Error object outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-string-boom-'))
    tempDirs.push(root)
    const modulePath = join(root, 'string-boom.mjs')
    await writeFile(modulePath, 'throw "boom"\n', 'utf8')

    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toBe('boom')
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('treats module resolution failures with a resolver message as optional outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-resolve-'))
    tempDirs.push(root)
    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    const originalImport = storageRuntimeInternals.importOptionalModule
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockImplementationOnce(async (specifier: string) => {
      return await originalImport(specifier)
    })

    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(join(root, 'missing.mjs')).href)).resolves.toBeUndefined()
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('does not treat unrelated "Failed to load url" failures as missing modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-failed-url-'))
    tempDirs.push(root)
    const modulePath = join(root, 'broken.mjs')
    await writeFile(modulePath, `throw new Error(${JSON.stringify(`Failed to load url ${pathToFileURL(modulePath).href} (syntax error)`)})\n`, 'utf8')
    const originalVitest = process.env.VITEST
    delete process.env.VITEST

    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(modulePath).href)).rejects.toThrow('Failed to load url')
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('returns undefined for missing optional storage modules outside Vitest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-runtime-missing-'))
    tempDirs.push(root)
    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      await expect(storageRuntimeInternals.importOptionalModule(pathToFileURL(join(root, 'missing.mjs')).href)).resolves.toBeUndefined()
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })
})
