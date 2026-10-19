import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import { normalizeModuleOptions } from '../src/config'
import { configureStorageRuntime, resetStorageRuntime, Storage, useStorage } from '../src/runtime/composables'

const root = join(tmpdir(), 'holo-storage-path')
const invalidWindowsNames = ['report.txt:payload', 'what?.txt', 'file<name.txt', 'a|b.txt', 'a*b.txt', 'a"b.txt', 'a>b.txt', 'a\u0001b.txt', 'report.txt.', 'folder /report.txt', 'CON', 'nul.txt', 'COM1.log', 'LPT9']

afterEach(() => resetStorageRuntime())

describe('local path names', () => {
  it.each([...new Set([process.platform, 'win32', 'linux'])])('validates literal file names on %s and leaves S3 names intact', async (platform) => {
    configureStorageRuntime({
      getRuntimeConfig: () => ({ holoStorage: normalizeModuleOptions({
        defaultDisk: 'local',
        disks: {
          local: { driver: 'local', root },
          media: { driver: 's3', bucket: 'files' },
        },
      }) }),
      getStorage: () => storageRuntimeInternals.createFileStorageBackend(root),
    })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!descriptor) throw new Error('Missing platform descriptor')
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      for (const name of invalidWindowsNames) {
        if (platform === 'win32') {
          expect(() => Storage.path(name)).toThrow('Windows')
          await expect(Storage.put(name, 'data')).rejects.toThrow('Windows')
          await expect(Storage.get(name)).rejects.toThrow('Windows')
          await expect(Storage.delete(name)).rejects.toThrow('Windows')
        } else {
          expect(Storage.path(name)).toBe(`${root}/${name}`)
        }
        expect(Storage.disk('media').path(name)).toBe(`s3://files/${name}`)
      }
      if (platform === 'win32') {
        for (const name of ['report.txt ', ' CON', '\tCOM1.txt']) {
          expect(() => Storage.path(name)).toThrow('Windows')
        }
        for (const key of ['report.txt%24.', 'report.txt%24%20', 'nul.txt']) {
          await expect(useStorage('local').getItemRaw(key)).rejects.toThrow('Windows')
        }
      }
      expect(Storage.path('reports/Q1 café 100% $5.txt')).toBe(`${root}/reports/Q1 café 100% $5.txt`)
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
