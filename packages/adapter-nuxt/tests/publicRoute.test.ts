import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoloStorageRuntimeConfig } from '@holo-js/storage'

const readFile = vi.fn()
const realpath = vi.fn()
const setResponseHeader = vi.fn()

vi.mock('node:fs/promises', () => ({
  readFile,
  realpath,
}))

vi.mock('#imports', () => ({
  useRuntimeConfig: () => ({ holoStorage: runtimeConfig }),
}))
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => {
  const error = new Error(input.statusMessage)
  ;(error as Error & { statusCode?: number }).statusCode = input.statusCode
  return error
})
vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/test.txt'))
vi.stubGlobal('setResponseHeader', setResponseHeader)

const {
  default: storageHandler,
  resolvePublicStorageRequest,
} = await import('../src/runtime/server/routes/storage.get')

const runtimeConfig: HoloStorageRuntimeConfig = {
  defaultDisk: 'public',
  diskNames: ['public', 'assets', 'private'],
  routePrefix: '/storage',
  disks: {
    public: {
      name: 'public',
      driver: 'public',
      visibility: 'public',
      root: './storage/app/public',
    },
    assets: {
      name: 'assets',
      driver: 'public',
      visibility: 'public',
      root: './storage/assets',
    },
    private: {
      name: 'private',
      driver: 'local',
      visibility: 'private',
      root: './storage/app',
    },
  },
}

function createReadError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

describe('public storage route resolution', () => {
  beforeEach(() => {
    readFile.mockReset()
    realpath.mockReset()
    realpath.mockImplementation(async (path: string) => path)
    setResponseHeader.mockReset()
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/test.txt'))
  })

  it('resolves the default public disk at the bare route prefix', () => {
    const resolved = resolvePublicStorageRequest(runtimeConfig, '/avatars/user-1.png')

    expect(resolved?.disk.name).toBe('public')
    expect(resolved?.absolutePath).toContain('/storage/app/public/avatars/user-1.png')
  })

  it('resolves the default public disk first for colliding named-disk prefixes', () => {
    const resolved = resolvePublicStorageRequest(runtimeConfig, '/assets/avatars/user-2.png')

    expect(resolved?.disk.name).toBe('public')
    expect(resolved?.absolutePath).toContain('/storage/app/public/assets/avatars/user-2.png')
  })

  it('resolves named public disks when no default public disk is configured', () => {
    const resolved = resolvePublicStorageRequest({
      ...runtimeConfig,
      disks: {
        ...runtimeConfig.disks,
        public: {
          ...runtimeConfig.disks.public!,
          visibility: 'private',
        },
      },
    }, '/assets/avatars/user-2.png')

    expect(resolved?.disk.name).toBe('assets')
    expect(resolved?.absolutePath).toContain('/storage/assets/avatars/user-2.png')
  })

  it('falls back to the default public disk when a named disk prefix misses on disk', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/assets/logo.png')) {
        throw createReadError('ENOENT')
      }

      if (path.endsWith('/storage/assets/logo.png')) {
        return Buffer.from('named-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('named-logo'))
    expect(readFile.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('/storage/app/public/assets/logo.png'),
      expect.stringContaining('/storage/assets/logo.png'),
    ])
  })

  it('serves named public disks from the reserved route namespace without probing the default disk', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/__holo/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/assets/logo.png')) {
        return Buffer.from('named-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('named-logo'))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('/storage/assets/logo.png'))
  })

  it('serves default public disk files under the reserved namespace when no named disk matches', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/__holo/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/__holo/logo.png')) {
        return Buffer.from('default-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('default-logo'))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining('/storage/app/public/__holo/logo.png'),
    )
  })

  it('returns not found for reserved namespace requests when the named disk file is missing', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/__holo/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/assets/logo.png')) {
        throw createReadError('ENOENT')
      }

      if (path.endsWith('/storage/app/public/__holo/assets/logo.png')) {
        return Buffer.from('wrong-disk')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('/storage/assets/logo.png'))
  })

  it('prefers the default public disk when a named disk collides with an existing public path', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/assets/logo.png')) {
        return Buffer.from('public-logo')
      }

      if (path.endsWith('/storage/assets/logo.png')) {
        return Buffer.from('named-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('public-logo'))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('/storage/app/public/assets/logo.png'))
  })

  it('returns a not-found error when no route can be resolved', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/'))

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
  })

  it('does not fall back to a different disk when the primary read fails for a non-missing error', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/assets/logo.png')) {
        throw createReadError('EACCES')
      }

      if (path.endsWith('/storage/assets/logo.png')) {
        return Buffer.from('named-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).rejects.toMatchObject({ code: 'EACCES' })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('/storage/app/public/assets/logo.png'))
  })

  it('reads from a named public disk when the default public disk is unavailable', async () => {
    const originalVisibility = runtimeConfig.disks.public?.visibility
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.txt'))
    runtimeConfig.disks.public!.visibility = 'private'
    readFile.mockResolvedValue(Buffer.from('named-logo'))

    try {
      await expect(storageHandler({})).resolves.toEqual(Buffer.from('named-logo'))
      expect(readFile).toHaveBeenCalledWith(expect.stringContaining('/storage/assets/logo.txt'))
    } finally {
      runtimeConfig.disks.public!.visibility = originalVisibility ?? 'public'
    }
  })

  it('returns not found for valid paths that do not map to any public disk', async () => {
    const originalVisibility = runtimeConfig.disks.public?.visibility
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/missing/logo.txt'))
    runtimeConfig.disks.public!.visibility = 'private'

    try {
      await expect(storageHandler({})).rejects.toMatchObject({
        statusCode: 404,
        message: 'Storage file not found.',
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      runtimeConfig.disks.public!.visibility = originalVisibility ?? 'public'
    }
  })

  it('sets the content type from the resolved file extension', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/avatars/user-1.png'))
    readFile.mockResolvedValue(Buffer.from('png-data'))

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('png-data'))
    expect(setResponseHeader).toHaveBeenCalledWith({}, 'content-type', 'image/png')
  })

  it('decodes URL-escaped path segments before reading local public files', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/reports/My%20File%20%231.pdf'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/reports/My File #1.pdf')) {
        return Buffer.from('pdf-data')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('pdf-data'))
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining('/storage/app/public/reports/My File #1.pdf'),
    )
  })

  it('preserves malformed escape sequences instead of rejecting the request path', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/reports/%E0%A4%A.txt'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/reports/%E0%A4%A.txt')) {
        return Buffer.from('raw-escape-data')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('raw-escape-data'))
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining('/storage/app/public/reports/%E0%A4%A.txt'),
    )
  })

  it('rejects files that resolve outside the public root through symlinks', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/linked/report.txt'))
    realpath.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public')) {
        return '/resolved/storage/app/public'
      }

      if (path.endsWith('/storage/app/public/linked/report.txt')) {
        return '/private/report.txt'
      }

      throw new Error(`unexpected realpath: ${path}`)
    })
    readFile.mockResolvedValue(Buffer.from('leaked-data'))

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('maps known file extensions to content types and falls back for unknown types', async () => {
    const cases = [
      ['asset.avif', 'image/avif'],
      ['asset.css', 'text/css; charset=utf-8'],
      ['asset.gif', 'image/gif'],
      ['asset.html', 'text/html; charset=utf-8'],
      ['asset.jpeg', 'image/jpeg'],
      ['asset.jpg', 'image/jpeg'],
      ['asset.js', 'text/javascript; charset=utf-8'],
      ['asset.mjs', 'text/javascript; charset=utf-8'],
      ['asset.json', 'application/json; charset=utf-8'],
      ['asset.mp3', 'audio/mpeg'],
      ['asset.pdf', 'application/pdf'],
      ['asset.png', 'image/png'],
      ['asset.svg', 'image/svg+xml'],
      ['asset.txt', 'text/plain; charset=utf-8'],
      ['asset.webp', 'image/webp'],
      ['asset.woff', 'font/woff'],
      ['asset.woff2', 'font/woff2'],
      ['asset.bin', 'application/octet-stream'],
    ] as const

    for (const [fileName, contentType] of cases) {
      setResponseHeader.mockReset()
      vi.stubGlobal('getRequestURL', () => new URL(`https://app.test/storage/${fileName}`))
      readFile.mockResolvedValue(Buffer.from(fileName))

      await expect(storageHandler({})).resolves.toEqual(Buffer.from(fileName))
      expect(setResponseHeader).toHaveBeenCalledWith({}, 'content-type', contentType)
    }
  })

  it('treats non-prefixed request paths as direct storage paths', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/assets/logo.txt'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/assets/logo.txt')) {
        throw createReadError('ENOENT')
      }

      if (path.endsWith('/storage/assets/logo.txt')) {
        return Buffer.from('named-logo')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).resolves.toEqual(Buffer.from('named-logo'))
    expect(setResponseHeader).toHaveBeenCalledWith({}, 'content-type', 'text/plain; charset=utf-8')
  })

  it('returns not found when both the primary and fallback locations are missing', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.png'))
    readFile.mockRejectedValue(createReadError('ENOENT'))

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('treats directory reads as not found', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/avatars'))
    readFile.mockRejectedValue(createReadError('EISDIR'))

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
  })

  it('returns not found when a default public path misses and no alternate disk matches', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/avatars/logo.png'))
    readFile.mockRejectedValue(createReadError('ENOENT'))

    await expect(storageHandler({})).rejects.toMatchObject({
      statusCode: 404,
      message: 'Storage file not found.',
    })
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('rethrows non-missing fallback errors after a primary miss', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/assets/logo.png'))
    readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('/storage/app/public/assets/logo.png')) {
        throw createReadError('ENOENT')
      }

      if (path.endsWith('/storage/assets/logo.png')) {
        throw createReadError('EACCES')
      }

      throw new Error(`unexpected path: ${path}`)
    })

    await expect(storageHandler({})).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rethrows primitive read errors without treating them as missing files', async () => {
    vi.stubGlobal('getRequestURL', () => new URL('https://app.test/storage/avatars/logo.png'))
    readFile.mockRejectedValue('boom')

    await expect(storageHandler({})).rejects.toBe('boom')
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('rejects empty and traversing paths', () => {
    expect(resolvePublicStorageRequest(runtimeConfig, '/')).toBeNull()
    expect(resolvePublicStorageRequest(runtimeConfig, '/__holo')).toMatchObject({
      disk: { name: 'public' },
    })
    expect(resolvePublicStorageRequest({
      ...runtimeConfig,
      disks: {
        ...runtimeConfig.disks,
        public: {
          ...runtimeConfig.disks.public!,
          visibility: 'private',
        },
      },
    }, '/assets')).toBeNull()
    expect(resolvePublicStorageRequest({
      ...runtimeConfig,
      disks: {
        ...runtimeConfig.disks,
        public: {
          ...runtimeConfig.disks.public!,
          visibility: 'private',
        },
      },
    }, '/missing/logo.txt')).toBeNull()
    expect(resolvePublicStorageRequest(runtimeConfig, '/../secrets.txt')).toBeNull()
    expect(resolvePublicStorageRequest(runtimeConfig, '/assets/../../secrets.txt')).toBeNull()
  })
})
