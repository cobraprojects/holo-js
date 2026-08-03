import { join } from 'node:path'
import { HOLO_PACKAGE_VERSION } from './metadata'
import { readTextFile, writeTextFile } from './project'
import { resolveManagedHoloPackageVersion } from './project/dependency-versions'
import { resolveWorkspacePackageNames } from './project/workspaces'

type PackageJsonDependencyState = {
  readonly packageJsonPath: string
  readonly parsed: Record<string, unknown>
  readonly dependencies: Record<string, string>
  readonly devDependencies: Record<string, string>
}

function normalizeDependencyMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, dependencyVersion]) => typeof dependencyVersion === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function assertValidDependencyName(packageName: string): void {
  if (
    !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName)
    && !/^[a-z0-9][a-z0-9._-]*$/.test(packageName)
  ) {
    throw new Error(`Invalid dependency package name: ${packageName || '(empty)'}.`)
  }
}

function resolveInstalledPackageJsonPath(projectRoot: string, packageName: string): string {
  return join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
}

async function resolveInstalledPackageVersion(
  projectRoot: string,
  packageName: string,
): Promise<string | undefined> {
  const packageJson = await readTextFile(resolveInstalledPackageJsonPath(projectRoot, packageName))
  if (!packageJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(packageJson) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? `^${parsed.version.trim()}`
      : undefined
  } catch {
    return undefined
  }
}

async function resolvePackageVersion(
  projectRoot: string,
  packageName: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  workspacePackageNames: ReadonlySet<string>,
): Promise<string> {
  const currentPackageVersion = dependencies[packageName] ?? devDependencies[packageName]
  if (packageName.startsWith('@holo-js/')) {
    return resolveManagedHoloPackageVersion(
      packageName,
      currentPackageVersion,
      HOLO_PACKAGE_VERSION,
      workspacePackageNames,
    )
  }
  if (typeof currentPackageVersion === 'string') return currentPackageVersion

  return await resolveInstalledPackageVersion(projectRoot, packageName) ?? 'latest'
}

function sortDependencyMap(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )
}

async function readPackageJsonDependencyState(projectRoot: string): Promise<PackageJsonDependencyState> {
  const packageJsonPath = join(projectRoot, 'package.json')
  const packageJson = await readTextFile(packageJsonPath)
  if (!packageJson) {
    throw new Error(`Missing package.json in ${projectRoot}.`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(packageJson) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid package.json in ${projectRoot}.`)
  }

  return {
    packageJsonPath,
    parsed,
    dependencies: normalizeDependencyMap(parsed.dependencies),
    devDependencies: normalizeDependencyMap(parsed.devDependencies),
  }
}

async function writePackageJsonDependencyState(state: PackageJsonDependencyState): Promise<void> {
  state.parsed.dependencies = sortDependencyMap(state.dependencies)

  if (Object.keys(state.devDependencies).length > 0) {
    state.parsed.devDependencies = sortDependencyMap(state.devDependencies)
  } else {
    delete state.parsed.devDependencies
  }

  await writeTextFile(state.packageJsonPath, `${JSON.stringify(state.parsed, null, 2)}\n`)
}

export async function hasProjectDependency(projectRoot: string, packageName: string): Promise<boolean> {
  const packageJson = await readTextFile(join(projectRoot, 'package.json'))
  if (!packageJson) {
    return false
  }

  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof parsed.dependencies?.[packageName] === 'string'
      || typeof parsed.devDependencies?.[packageName] === 'string'
  } catch {
    return false
  }
}

export async function upsertProjectDependency(
  projectRoot: string,
  packageName: string,
): Promise<boolean> {
  assertValidDependencyName(packageName)
  const state = await readPackageJsonDependencyState(projectRoot)
  const workspacePackageNames = await resolveWorkspacePackageNames(projectRoot)
  const nextVersion = await resolvePackageVersion(projectRoot, packageName, state.dependencies, state.devDependencies, workspacePackageNames)

  if (state.dependencies[packageName] === nextVersion && typeof state.devDependencies[packageName] === 'undefined') {
    return false
  }

  state.dependencies[packageName] = nextVersion
  delete state.devDependencies[packageName]
  await writePackageJsonDependencyState(state)
  return true
}

export async function pinProjectDependencyVersions(
  projectRoot: string,
  packageNames: readonly string[],
): Promise<boolean> {
  const state = await readPackageJsonDependencyState(projectRoot)
  let changed = false

  for (const packageName of packageNames) {
    assertValidDependencyName(packageName)
    if (packageName.startsWith('@holo-js/')) {
      continue
    }

    const installedVersion = await resolveInstalledPackageVersion(projectRoot, packageName)
    if (!installedVersion) {
      continue
    }

    if (state.dependencies[packageName] === 'latest') {
      state.dependencies[packageName] = installedVersion
      changed = true
    }

    if (state.devDependencies[packageName] === 'latest') {
      state.devDependencies[packageName] = installedVersion
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(state)
  return true
}

export async function removeProjectDependency(
  projectRoot: string,
  packageName: string,
): Promise<boolean> {
  assertValidDependencyName(packageName)
  const state = await readPackageJsonDependencyState(projectRoot)

  if (typeof state.dependencies[packageName] === 'undefined' && typeof state.devDependencies[packageName] === 'undefined') {
    return false
  }

  delete state.dependencies[packageName]
  delete state.devDependencies[packageName]
  await writePackageJsonDependencyState(state)
  return true
}
