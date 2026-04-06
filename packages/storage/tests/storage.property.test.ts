import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  buildStorageConfig,
  normalizeDiskConfig,
  normalizeStorageDriver,
} from '../src'
import type { DiskConfig, StorageDriver } from '../src'

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

describe('Property 2: Nitro storage config generation', () => {
  const arbDiskName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/)
  const arbLocalPrivateDisk: fc.Arbitrary<DiskConfig> = fc.record({
    driver: fc.constant<StorageDriver>('local'),
    root: fc.stringMatching(/^\.\/[a-z0-9/_-]{1,20}$/),
    visibility: fc.option(fc.constant<'private'>('private'), { nil: undefined }),
  })
  const arbPublicLocalDisk: fc.Arbitrary<DiskConfig> = fc.record({
    driver: fc.constant<StorageDriver>('public'),
    root: fc.stringMatching(/^\.\/[a-z0-9/_-]{1,20}$/),
    visibility: fc.option(fc.constantFrom<'private' | 'public'>('private', 'public'), { nil: undefined }),
  })
  const arbLocalDisk: fc.Arbitrary<DiskConfig> = fc.oneof(arbLocalPrivateDisk, arbPublicLocalDisk)

  const arbS3Disk: fc.Arbitrary<DiskConfig> = fc.record({
    driver: fc.constant<StorageDriver>('s3'),
    bucket: fc.stringMatching(/^[a-z0-9-]{3,20}$/),
    region: fc.constantFrom('us-east-1', 'eu-west-1', 'auto'),
    endpoint: fc.option(fc.webUrl(), { nil: undefined }),
    accessKeyId: fc.option(fc.stringMatching(/^[A-Z0-9]{6,20}$/), { nil: undefined }),
    secretAccessKey: fc.option(fc.stringMatching(/^[a-z0-9]{12,40}$/), { nil: undefined }),
    forcePathStyleEndpoint: fc.option(fc.boolean(), { nil: undefined }),
    visibility: fc.option(fc.constantFrom<'private' | 'public'>('private', 'public'), { nil: undefined }),
  })

  it('always emits fs for local/public disks and s3 for object storage disks', () => {
    fc.assert(
      fc.property(
        arbDiskName,
        fc.oneof(arbLocalDisk, arbS3Disk),
        (diskName, rawDisk) => {
          const normalized = normalizeDiskConfig(diskName, rawDisk)
          const built = buildStorageConfig(normalized)

          if (normalized.driver === 's3') {
            expect(built.driver).toBe('s3')
            expect(built.bucket).toBe(normalized.bucket)
            expect(built.region).toBe(normalized.region)
          } else {
            expect(built.driver).toBe('fs')
            expect(built.base).toBe(normalized.root)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

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
