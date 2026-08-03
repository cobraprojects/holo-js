import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
const localDependencySections = new Set([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
])
const projectDependencySections = ['dependencies', 'devDependencies']
const manifestBackupName = '.holo-smoke-package.json'
const packageIndexName = 'workspace-packages.json'
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function resolveWorkspaceRange(packageName, range, workspaceVersions) {
  const version = workspaceVersions.get(packageName)
  if (!version) {
    throw new Error(`Missing workspace version for "${packageName}".`)
  }

  const workspaceRange = range.slice('workspace:'.length)
  if (workspaceRange === '^' || workspaceRange === '~') {
    return `${workspaceRange}${version}`
  }

  return version
}

function resolveDependencyRange(packageName, range, catalog, workspaceVersions) {
  if (range === 'catalog:') {
    const catalogRange = catalog[packageName]
    if (typeof catalogRange !== 'string') {
      throw new Error(`Missing catalog range for "${packageName}".`)
    }
    return catalogRange
  }

  if (range.startsWith('workspace:')) {
    return resolveWorkspaceRange(packageName, range, workspaceVersions)
  }

  return range
}

export function resolveLocalInstallManifest(
  manifest,
  catalog,
  localPackageRoots,
  workspaceVersions,
) {
  const resolvedManifest = structuredClone(manifest)

  for (const sectionName of dependencySections) {
    const section = resolvedManifest[sectionName]
    if (!isObject(section)) {
      continue
    }

    for (const [packageName, range] of Object.entries(section)) {
      if (typeof range !== 'string') {
        continue
      }

      const localPackageRoot = localPackageRoots.get(packageName)
      section[packageName] = localPackageRoot && localDependencySections.has(sectionName)
        ? pathToFileURL(localPackageRoot).href
        : resolveDependencyRange(packageName, range, catalog, workspaceVersions)
    }
  }

  return resolvedManifest
}

async function readWorkspacePackages(rootDir) {
  const packageDirectory = join(rootDir, 'packages')
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  const packages = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const directory = join(packageDirectory, entry.name)
    const manifestPath = join(directory, 'package.json')
    if (!await pathExists(manifestPath)) {
      continue
    }

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (
      typeof manifest.name !== 'string'
      || !manifest.name.startsWith('@holo-js/')
      || typeof manifest.version !== 'string'
    ) {
      continue
    }

    packages.push({
      directory,
      packageDirectoryName: entry.name,
      manifest,
    })
  }

  return packages
}

export async function stageLocalWorkspacePackages(rootDir, tempRoot) {
  const rootManifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'))
  const catalog = rootManifest.workspaces?.catalog
  if (!isObject(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }

  const packages = await readWorkspacePackages(rootDir)
  const stagingRoot = join(tempRoot, 'local-packages')
  const sourceRoot = join(tempRoot, 'local-package-sources')
  const localPackageRoots = new Map(packages.map(item => [
    item.manifest.name,
    join(
      stagingRoot,
      `${item.manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${item.manifest.version}.tgz`,
    ),
  ]))
  const workspaceVersions = new Map(packages.map(item => [
    item.manifest.name,
    item.manifest.version,
  ]))
  await mkdir(stagingRoot, { recursive: true })
  await mkdir(sourceRoot, { recursive: true })

  for (const item of packages) {
    const distPath = join(item.directory, 'dist')
    if (!await pathExists(distPath)) {
      throw new Error(`Built package output is missing for "${item.manifest.name}".`)
    }

    const packageArchivePath = localPackageRoots.get(item.manifest.name)
    if (!packageArchivePath) {
      throw new Error(`Missing staging path for "${item.manifest.name}".`)
    }

    const targetRoot = join(sourceRoot, item.packageDirectoryName)
    await mkdir(targetRoot, { recursive: true })
    await cp(distPath, join(targetRoot, 'dist'), { recursive: true })
    const manifest = resolveLocalInstallManifest(
      item.manifest,
      catalog,
      localPackageRoots,
      workspaceVersions,
    )
    await writeFile(join(targetRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const result = spawnSync(npmBinary, [
      'pack',
      targetRoot,
      '--pack-destination',
      stagingRoot,
      '--ignore-scripts',
      '--json',
    ], {
      cwd: rootDir,
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error([
        `Could not pack local workspace package "${item.manifest.name}".`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n'))
    }
    if (!await pathExists(packageArchivePath)) {
      throw new Error(`Package archive is missing for "${item.manifest.name}".`)
    }
  }

  await writeFile(
    join(stagingRoot, packageIndexName),
    `${JSON.stringify(Object.fromEntries(localPackageRoots), null, 2)}\n`,
  )

  return stagingRoot
}

async function readLocalPackageRoots(stagingRoot) {
  const packageIndex = JSON.parse(await readFile(join(stagingRoot, packageIndexName), 'utf8'))
  if (!isObject(packageIndex)) {
    throw new Error(`Invalid local workspace package index in ${stagingRoot}.`)
  }

  return new Map(Object.entries(packageIndex).filter(([, packageRoot]) => typeof packageRoot === 'string'))
}

export function resolveProjectLocalDependencies(manifest, localPackageRoots) {
  const resolvedManifest = structuredClone(manifest)

  for (const sectionName of projectDependencySections) {
    const section = resolvedManifest[sectionName]
    if (!isObject(section)) {
      continue
    }

    for (const packageName of Object.keys(section)) {
      const localPackageRoot = localPackageRoots.get(packageName)
      if (localPackageRoot) {
        section[packageName] = pathToFileURL(localPackageRoot).href
      }
    }
  }

  return resolvedManifest
}

export async function activateLocalWorkspacePackages(projectRoot, stagingRoot) {
  const manifestPath = join(projectRoot, 'package.json')
  const backupPath = join(projectRoot, manifestBackupName)
  const original = await readFile(manifestPath, 'utf8')
  await writeFile(backupPath, original, { flag: 'wx' })

  try {
    const localPackageRoots = await readLocalPackageRoots(stagingRoot)
    const manifest = resolveProjectLocalDependencies(JSON.parse(original), localPackageRoots)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    await rm(backupPath, { force: true })
    throw error
  }
}

export async function restoreProjectManifest(projectRoot) {
  const manifestPath = join(projectRoot, 'package.json')
  const backupPath = join(projectRoot, manifestBackupName)
  const original = await readFile(backupPath, 'utf8')
  await writeFile(manifestPath, original)
  await rm(backupPath, { force: true })
}
