import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

type PackageManifest = {
  dependencies?: Record<string, string>
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isWorkspaceDependency(dependencyName: string): boolean {
  return dependencyName.startsWith('@holo-js/')
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
}

export async function stagePublishedPackage(
  sourceDir: string,
  targetDir: string,
  distDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'package.json'), readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  await cp(distDir, join(targetDir, 'dist'), { recursive: true })
}
