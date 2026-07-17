import { describe, expect, it } from 'vitest'
import { holoStorageDefaults, normalizeStorageConfig } from '../src'

describe('feature-owned storage config', () => {
  it('owns defaults and normalization without config runtime dependencies', () => {
    expect(normalizeStorageConfig()).toEqual(holoStorageDefaults)
    expect(normalizeStorageConfig({
      defaultDisk: 'archive',
      routePrefix: '/files',
      disks: { archive: { driver: 's3', bucket: 'archive' } },
    })).toEqual({
      defaultDisk: 'archive',
      routePrefix: '/files',
      disks: {
        ...holoStorageDefaults.disks,
        archive: { driver: 's3', bucket: 'archive' },
      },
    })
  })
})
