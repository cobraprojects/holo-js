import { describe, expect, it } from 'vitest'
import { resolveManagedHoloPackageVersion } from '../src/project/dependency-versions'

const packageName = '@holo-js/core'
const currentVersion = '0.3.8'

describe('managed Holo dependency versions', () => {
  it('upgrades ranges that cannot resolve to the current framework version', () => {
    expect(resolveManagedHoloPackageVersion(packageName, '^0.0.1', currentVersion, new Set()))
      .toBe('^0.3.8')
  })

  it('preserves compatible and newer valid ranges', () => {
    expect(resolveManagedHoloPackageVersion(packageName, '~0.3.8', currentVersion, new Set()))
      .toBe('~0.3.8')
    expect(resolveManagedHoloPackageVersion(packageName, '^99.0.0', currentVersion, new Set()))
      .toBe('^99.0.0')
  })

  it('preserves catalog and real workspace package versions', () => {
    expect(resolveManagedHoloPackageVersion(packageName, 'catalog:', currentVersion, new Set()))
      .toBe('catalog:')
    expect(resolveManagedHoloPackageVersion(packageName, 'workspace:^', currentVersion, new Set([packageName])))
      .toBe('workspace:^')
  })

  it('replaces unmanaged workspace and invalid specifications', () => {
    expect(resolveManagedHoloPackageVersion(packageName, 'workspace:*', currentVersion, new Set()))
      .toBe('^0.3.8')
    expect(resolveManagedHoloPackageVersion(packageName, 'latest', currentVersion, new Set()))
      .toBe('^0.3.8')
  })
})
