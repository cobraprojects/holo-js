import { gte, minVersion, satisfies, valid, validRange } from 'semver'

export type HoloVersionPrefix = '' | '~' | '^'

export function isWorkspaceDependencyVersion(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('workspace:')
}

export function resolveHoloVersionPrefix(...dependencyMaps: readonly Readonly<Record<string, string>>[]): HoloVersionPrefix {
  const versions = dependencyMaps
    .flatMap(dependencies => Object.entries(dependencies))
    .filter(([name, version]) => name.startsWith('@holo-js/') && !version.startsWith('catalog:') && !isWorkspaceDependencyVersion(version))
    .map(([, version]) => version.trim())
  if (versions.length === 0) return '^'
  if (versions.every(version => valid(version.replace(/^=\s*/, '')) !== null)) return ''
  if (versions.every(version => version.startsWith('~') && valid(version.slice(1).trim()) !== null)) return '~'
  return '^'
}

export function resolveManagedHoloPackageVersion(
  packageName: string,
  currentPackageVersion: string | undefined,
  holoPackageVersion: string,
  workspacePackageNames: ReadonlySet<string>,
  versionPrefix: HoloVersionPrefix = '^',
): string {
  if (currentPackageVersion === 'catalog:') return currentPackageVersion
  if (workspacePackageNames.has(packageName)) {
    return isWorkspaceDependencyVersion(currentPackageVersion) ? currentPackageVersion : 'workspace:*'
  }

  const targetRange = `${versionPrefix}${holoPackageVersion}`
  if (!currentPackageVersion || !validRange(currentPackageVersion)) return targetRange
  if (satisfies(holoPackageVersion, currentPackageVersion)) return currentPackageVersion

  const minimumCurrentVersion = minVersion(currentPackageVersion)
  if (minimumCurrentVersion && gte(minimumCurrentVersion, holoPackageVersion)) {
    return currentPackageVersion
  }

  return targetRange
}
