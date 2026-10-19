import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  normalizeDiskConfig,
  normalizeStorageDriver,
} from '../src'
import type { StorageDriver } from '../src'

describe('Property 1: Disk driver normalization', () => {
  const arbDriver = fc.constantFrom<StorageDriver>('local', 'public', 's3')

  it('always maps declared drivers into the runtime driver set', () => {
    fc.assert(
      fc.property(arbDriver, (driver) => {
        const normalized = normalizeStorageDriver(driver)
        expect(['local', 'public', 's3']).toContain(normalized)

        if (driver === 'public') {
          expect(normalized).toBe('public')
        }

        if (driver === 's3') {
          expect(normalized).toBe('s3')
        }
      }),
      { numRuns: 100 },
    )
  })
})

describe('Property 2: Local disk visibility', () => {
  const arbDiskName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/)

  it('rejects local disks configured as public', () => {
    fc.assert(
      fc.property(
        arbDiskName,
        fc.stringMatching(/^\.\/[a-z0-9/_-]{1,20}$/),
        (diskName, root) => {
          expect(() => normalizeDiskConfig(diskName, {
            driver: 'local',
            root,
            visibility: 'public',
          })).toThrow('Local disks must remain private')
        },
      ),
      { numRuns: 100 },
    )
  })
})
