import { gte, minVersion, satisfies, validRange } from 'semver'

export function isWorkspaceDependencyVersion(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('workspace:')
}

export function resolveManagedHoloPackageVersion(
  packageName: string,
  currentPackageVersion: string | undefined,
  holoPackageVersion: string,
  workspacePackageNames: ReadonlySet<string>,
): string {
  if (currentPackageVersion === 'catalog:') return currentPackageVersion
  if (workspacePackageNames.has(packageName)) {
    return isWorkspaceDependencyVersion(currentPackageVersion) ? currentPackageVersion : 'workspace:*'
  }

  const targetRange = `^${holoPackageVersion}`
  if (!currentPackageVersion || !validRange(currentPackageVersion)) return targetRange
  if (satisfies(holoPackageVersion, currentPackageVersion)) return currentPackageVersion

  const minimumCurrentVersion = minVersion(currentPackageVersion)
  if (minimumCurrentVersion && gte(minimumCurrentVersion, holoPackageVersion)) {
    return currentPackageVersion
  }

  return targetRange
}
