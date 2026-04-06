import { describe, expect, it, vi } from 'vitest'
import type { HoloStorageRuntimeConfig } from '@holo-js/storage'

const runtimeConfig: HoloStorageRuntimeConfig = {
  defaultDisk: 'public',
  diskNames: ['public', 'assets'],
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
  },
}

describe('public storage route internals', () => {
  it('rejects default public disk requests whose resolved file escapes the disk root', async () => {
    vi.resetModules()
    vi.doMock('node:path', () => ({
      extname: (value: string) => value.slice(value.lastIndexOf('.')),
      resolve: (...segments: string[]) => {
        if (segments.length === 1 && segments[0] === './storage/app/public') {
          return '/mock/storage/app/public'
        }

        if (segments[0] === '/mock/storage/app/public') {
          return '/outside/storage/app/public'
        }

        return segments.join('/')
      },
      sep: '/',
    }))
    vi.doMock('#imports', () => ({
      useRuntimeConfig: () => ({ holoStorage: runtimeConfig }),
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

    const { resolvePublicStorageRequest } = await import('../src/runtime/server/routes/storage.get')

    expect(resolvePublicStorageRequest(runtimeConfig, '/escape.txt')).toBeNull()
  })

  it('rejects named disk requests whose resolved file escapes the disk root', async () => {
    vi.resetModules()
    vi.doMock('node:path', () => ({
      extname: (value: string) => value.slice(value.lastIndexOf('.')),
      resolve: (...segments: string[]) => {
        if (segments.length === 1 && segments[0] === './storage/assets') {
          return '/mock/storage/assets'
        }

        if (segments[0] === '/mock/storage/assets') {
          return '/outside/storage/assets'
        }

        return segments.join('/')
      },
      sep: '/',
    }))
    vi.doMock('#imports', () => ({
      useRuntimeConfig: () => ({ holoStorage: runtimeConfig }),
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

    const { resolvePublicStorageRequest } = await import('../src/runtime/server/routes/storage.get')

    expect(resolvePublicStorageRequest({
      ...runtimeConfig,
      disks: {
        ...runtimeConfig.disks,
        public: {
          ...runtimeConfig.disks.public!,
          visibility: 'private',
        },
      },
    }, '/assets/escape.txt')).toBeNull()
  })
})
