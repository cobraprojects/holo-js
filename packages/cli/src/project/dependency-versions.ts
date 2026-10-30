import { gte, minVersion, satisfies, valid, validRange } from 'semver'

export type HoloVersionPrefix = '' | '~' | '^'

export function isWorkspaceDependencyVersion(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('workspace:')
}

// Holo packages move together, so new and raised ones follow the project's existing pins:
// exact when every @holo-js/* version is exact, a tilde when every one uses a tilde, and a caret otherwise.
export function resolveHoloVersionPrefix(...dependencyMaps: readonly Readonly<Record<string, string>>[]): HoloVersionPrefix {
  const versions = dependencyMaps
    .flatMap(dependencies => Object.entries(dependencies))
    .filter(([name, version]) => name.startsWith('@holo-js/') && version !== 'catalog:' && !isWorkspaceDependencyVersion(version))
    .map(([, version]) => version.trim())
  if (versions.length === 0) return '^'
  if (versions.every(version => valid(version) === version)) return ''
  if (versions.every(version => version.startsWith('~') && valid(version.slice(1)) !== null)) return '~'
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
