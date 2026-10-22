import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { collectLibraryBuilds } from '../../scripts/build-libraries.mjs'

type PackageManifest = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  name?: string
}

export function stageWorkspacePackagesSync(
  repoRoot: string,
  targetPackagesRoot: string,
  packageNames: readonly string[],
): Array<{ name: string, directory: string }> {
  const builds: Array<{ name: string, directory: string }> = collectLibraryBuilds(repoRoot, packageNames)
  const packages = builds.map(({ name, directory }) => ({ name, sourceDirectory: directory, directory: join(targetPackagesRoot, basename(directory)) }))
  const targets = new Map(packages.map(({ name, directory }) => [name, directory]))
  for (const { sourceDirectory, directory } of packages) {
    const manifestText = readFileSync(join(sourceDirectory, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText) as PackageManifest
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), manifestText)
    linkInstalledDependenciesForPackageSync({
      repoRoot,
      nodeModulesRoot: join(directory, 'node_modules'),
      packageJsonPath: join(sourceDirectory, 'package.json'),
    })
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...requiredPeerDependencies(manifest) }
    for (const dependency of Object.keys(dependencies)) {
      const dependencyTarget = targets.get(dependency)
      if (dependencyTarget) symlinkPackageDependencySync(join(directory, 'node_modules'), dependency, dependencyTarget)
    }
  }
  return packages.map(({ name, directory }) => ({ name, directory }))
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..')

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isWorkspaceDependency(dependencyName: string): boolean {
  return dependencyName.startsWith('@holo-js/')
}

function requiredPeerDependencies(manifest: PackageManifest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {})
      .filter(([dependencyName]) => manifest.peerDependenciesMeta?.[dependencyName]?.optional !== true),
  )
}

function workspacePackageDirectories(): Map<string, string> {
  const packagesRoot = join(REPOSITORY_ROOT, 'packages')
  const directories = new Map<string, string>()
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const directory = join(packagesRoot, entry.name)
    const manifestPath = join(directory, 'package.json')
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    if (manifest.name) directories.set(manifest.name, directory)
  }
  return directories
}

function hasEntry(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

function readWorkspaceDependencies(packageJsonPath: string): Array<{ name: string, directory: string }> {
  const directories = workspacePackageDirectories()
  const found = new Map<string, string>()
  const visit = (manifestPath: string): void => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    const declared = { ...manifest.dependencies, ...requiredPeerDependencies(manifest) }
    for (const dependencyName of Object.keys(declared).filter(isWorkspaceDependency)) {
      if (found.has(dependencyName)) continue
      const directory = directories.get(dependencyName)
      if (!directory) continue
      found.set(dependencyName, directory)
      visit(join(directory, 'package.json'))
    }
  }
  visit(packageJsonPath)
  return [...found].map(([name, directory]) => ({ name, directory }))
}

export function readExternalDependencyNames(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest

  return Object.keys(packageJson.dependencies ?? {})
    .filter(dependencyName => !isWorkspaceDependency(dependencyName))
}

export function resolveInstalledDependencyRoot(repoRoot: string, dependencyName: string): string {
  const directPath = resolve(repoRoot, 'node_modules', ...dependencyName.split('/'))
  if (existsSync(directPath)) {
    return directPath
  }

  const bunStorePath = resolve(repoRoot, 'node_modules/.bun/node_modules', ...dependencyName.split('/'))
  if (existsSync(bunStorePath)) {
    return bunStorePath
  }

  throw new Error(`Installed dependency "${dependencyName}" was not found under "${repoRoot}/node_modules".`)
}

export async function symlinkPackageDependency(
  nodeModulesRoot: string,
  packageName: string,
  dependencyRoot: string,
): Promise<void> {
  const dependencyPath = join(nodeModulesRoot, ...packageName.split('/'))
  await rm(dependencyPath, { recursive: true, force: true })
  await mkdir(dirname(dependencyPath), { recursive: true })
  await symlink(dependencyRoot, dependencyPath)
}

export function symlinkPackageDependencySync(
  nodeModulesRoot: string,
  packageName: string,
  dependencyRoot: string,
): void {
  const dependencyPath = join(nodeModulesRoot, ...packageName.split('/'))
  rmSync(dependencyPath, { recursive: true, force: true })
  mkdirSync(dirname(dependencyPath), { recursive: true })
  symlinkSync(dependencyRoot, dependencyPath)
}

export async function linkInstalledDependenciesForPackage(options: {
  repoRoot: string
  nodeModulesRoot: string
  packageJsonPath: string
  extraDependencyNames?: readonly string[]
}): Promise<void> {
  const dependencyNames = unique([
    ...readExternalDependencyNames(options.packageJsonPath),
    ...(options.extraDependencyNames ?? []),
  ])

  for (const dependencyName of dependencyNames) {
    await symlinkPackageDependency(
      options.nodeModulesRoot,
      dependencyName,
      resolveInstalledDependencyRoot(options.repoRoot, dependencyName),
    )
  }
  for (const { name, directory } of readWorkspaceDependencies(options.packageJsonPath)) {
    if (hasEntry(join(options.nodeModulesRoot, ...name.split('/')))) continue
    await symlinkPackageDependency(options.nodeModulesRoot, name, directory)
  }
}

export function linkInstalledDependenciesForPackageSync(options: {
  repoRoot: string
  nodeModulesRoot: string
  packageJsonPath: string
  extraDependencyNames?: readonly string[]
}): void {
  const dependencyNames = unique([
    ...readExternalDependencyNames(options.packageJsonPath),
    ...(options.extraDependencyNames ?? []),
  ])

  for (const dependencyName of dependencyNames) {
    symlinkPackageDependencySync(
      options.nodeModulesRoot,
      dependencyName,
      resolveInstalledDependencyRoot(options.repoRoot, dependencyName),
    )
  }
  for (const { name, directory } of readWorkspaceDependencies(options.packageJsonPath)) {
    if (hasEntry(join(options.nodeModulesRoot, ...name.split('/')))) continue
    symlinkPackageDependencySync(options.nodeModulesRoot, name, directory)
  }
}

export async function provisionTempPackage(sourcePackageDir: string, tempPackageDir: string): Promise<void> {
  await cp(sourcePackageDir, tempPackageDir, {
    recursive: true,
    filter(source) {
      return !source.includes('/dist/')
        && !source.endsWith('/dist')
        && !source.includes('/tests/')
        && !source.endsWith('/tests')
        && !source.includes('/node_modules/')
        && !source.endsWith('/node_modules')
    },
  })
  await linkInstalledDependenciesForPackage({
    repoRoot: sourcePackageDir,
    nodeModulesRoot: join(tempPackageDir, 'node_modules'),
    packageJsonPath: join(sourcePackageDir, 'package.json'),
  })
}

const publishedPackageStagings = new Map<string, Promise<void>>()

export function stagePublishedPackage(
  sourceDir: string,
  targetDir: string,
  distDir: string,
): Promise<void> {
  const stagingKey = resolve(targetDir)
  const existingStaging = publishedPackageStagings.get(stagingKey)
  if (existingStaging) {
    return existingStaging
  }

  const staging = stagePublishedPackageContents(sourceDir, targetDir, distDir)
  publishedPackageStagings.set(stagingKey, staging)
  return staging
}

async function stagePublishedPackageContents(
  sourceDir: string,
  targetDir: string,
  distDir: string,
): Promise<void> {
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const manifestText = readFileSync(join(sourceDir, 'package.json'), 'utf8')
  const manifest = JSON.parse(manifestText) as PackageManifest
  await writeFile(join(targetDir, 'package.json'), manifestText)
  await cp(distDir, join(targetDir, 'dist'), { recursive: true })

  const nodeModulesRoot = manifest.name?.startsWith('@')
    ? resolve(targetDir, '../..')
    : resolve(targetDir, '..')
  const repoRoot = resolve(sourceDir, '../..')
  for (const dependencyName of Object.keys(manifest.dependencies ?? {}).filter(name => !isWorkspaceDependency(name))) {
    const dependencyRoot = resolveInstalledDependencyRoot(repoRoot, dependencyName)
    await symlinkPackageDependency(nodeModulesRoot, dependencyName, dependencyRoot)
  }

  for (const dependencyName of Object.keys(manifest.dependencies ?? {}).filter(isWorkspaceDependency)) {
    const dependencyDir = resolve(sourceDir, '..', dependencyName.slice('@holo-js/'.length))
    const dependencyDist = join(dependencyDir, 'dist')
    if (!existsSync(join(dependencyDir, 'package.json')) || !existsSync(dependencyDist)) {
      continue
    }
    await stagePublishedPackage(
      dependencyDir,
      resolve(targetDir, '..', dependencyName.slice('@holo-js/'.length)),
      dependencyDist,
    )
  }
}
