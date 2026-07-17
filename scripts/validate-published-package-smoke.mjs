import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const rootDir = resolve(import.meta.dirname, '..')
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const frameworkApps = [
  { name: 'next', source: 'apps/blog-next' },
  { name: 'nuxt', source: 'apps/blog-nuxt' },
  { name: 'sveltekit', source: 'apps/blog-sveltekit' },
]

function log(message) {
  process.stdout.write(`[published-package-smoke] ${message}\n`)
}

function run(cwd, command, args) {
  log(`${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error([
      `Command failed in ${cwd}: ${command} ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
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
    const version = workspaceVersions.get(packageName)
    if (!version) {
      throw new Error(`Missing workspace package version for "${packageName}".`)
    }
    const workspaceRange = range.slice('workspace:'.length)
    if (workspaceRange === '^' || workspaceRange === '~') {
      return `${workspaceRange}${version}`
    }
    return version
  }
  return range
}

export function resolvePublishedManifest(manifest, catalog, workspaceVersions) {
  const resolvedManifest = structuredClone(manifest)
  for (const sectionName of dependencySections) {
    const section = resolvedManifest[sectionName]
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      continue
    }
    for (const [packageName, range] of Object.entries(section)) {
      if (typeof range === 'string') {
        section[packageName] = resolveDependencyRange(packageName, range, catalog, workspaceVersions)
      }
    }
  }
  return resolvedManifest
}

async function readPackageManifests() {
  const entries = await readdir(join(rootDir, 'packages'), { withFileTypes: true })
  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const directory = join(rootDir, 'packages', entry.name)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) {
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`Invalid package manifest at ${manifestPath}.`)
    }
    packages.push({ directory, manifest })
  }
  return packages
}

async function stagePackages(tempRoot, packages, catalog) {
  const nodeModulesRoot = join(tempRoot, 'node_modules')
  const workspaceVersions = new Map(packages.map(item => [item.manifest.name, item.manifest.version]))
  for (const item of packages) {
    const dist = join(item.directory, 'dist')
    if (!existsSync(dist)) {
      throw new Error(`Built package output is missing for "${item.manifest.name}".`)
    }
    const target = join(nodeModulesRoot, ...item.manifest.name.split('/'))
    await mkdir(target, { recursive: true })
    await cp(dist, join(target, 'dist'), { recursive: true })
    const manifest = resolvePublishedManifest(item.manifest, catalog, workspaceVersions)
    const serializedManifest = JSON.stringify(manifest)
    assert.doesNotMatch(serializedManifest, /(?:catalog|workspace):/)
    await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return nodeModulesRoot
}

async function linkExternalDependencies(nodeModulesRoot) {
  const sourceRoot = join(rootDir, 'node_modules')
  const dependencyRoots = [join(sourceRoot, '.bun/node_modules'), sourceRoot]
  for (const dependencyRoot of dependencyRoots) {
    const entries = await readdir(dependencyRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '@holo-js' || entry.name === '.bin' || entry.name === '.bun') {
        continue
      }
      const target = join(nodeModulesRoot, entry.name)
      if (existsSync(target)) {
        continue
      }
      await symlink(join(dependencyRoot, entry.name), target)
    }
  }

  const sourceBin = join(sourceRoot, '.bin')
  const targetBin = join(nodeModulesRoot, '.bin')
  await mkdir(targetBin, { recursive: true })
  for (const entry of await readdir(sourceBin)) {
    if (entry === 'holo') {
      continue
    }
    await symlink(join(sourceBin, entry), join(targetBin, entry))
  }
  await symlink(
    join(nodeModulesRoot, '@holo-js/cli/dist/bin/holo.mjs'),
    join(targetBin, 'holo'),
  )
}

async function verifyPackageImports(tempRoot, packages) {
  const importablePackages = packages
    .filter(item => typeof item.manifest.exports !== 'undefined')
    .map(item => item.manifest.name)
  const smokePath = join(tempRoot, 'package-import-smoke.mjs')
  await writeFile(smokePath, [
    `const packages = ${JSON.stringify(importablePackages)}`,
    'for (const packageName of packages) {',
    '  await import(packageName)',
    '}',
    `process.stdout.write(JSON.stringify({ imported: packages.length }))`,
    '',
  ].join('\n'))
  run(tempRoot, 'node', [smokePath])
}

async function copyFrameworkApp(source, target) {
  await cp(source, target, {
    recursive: true,
    filter(path) {
      const relative = path.slice(source.length).replace(/^\//, '')
      const rootSegment = relative.split('/')[0]
      return !['node_modules', '.next', '.nuxt', '.output', 'build'].includes(rootSegment)
    },
  })
}

function listManifestDependencyNames(manifest, includeDevDependencies = false) {
  const sections = includeDevDependencies
    ? dependencySections
    : ['dependencies', 'peerDependencies', 'optionalDependencies']
  return sections.flatMap(sectionName => Object.keys(manifest[sectionName] ?? {}))
}

function resolveInstalledPackageRoot(sourceAppRoot, packageName) {
  const segments = packageName.split('/')
  const candidates = [
    join(sourceAppRoot, 'node_modules', ...segments),
    join(rootDir, 'node_modules', ...segments),
    join(rootDir, 'node_modules/.bun/node_modules', ...segments),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'package.json')))
}

async function copyExternalDependencyClosure(
  sourceAppRoot,
  nodeModulesRoot,
  stagedNodeModules,
  options = {},
) {
  const appManifest = JSON.parse(await readFile(join(sourceAppRoot, 'package.json'), 'utf8'))
  const appDependencyNames = new Set(listManifestDependencyNames(appManifest, true))
  const pending = options.includeAppDependencies === false ? [] : [...appDependencyNames]
  const stagedScopeRoot = join(stagedNodeModules, '@holo-js')
  for (const packageDirectory of await readdir(stagedScopeRoot)) {
    const manifest = JSON.parse(await readFile(join(stagedScopeRoot, packageDirectory, 'package.json'), 'utf8'))
    pending.push(...listManifestDependencyNames(manifest))
  }

  const visited = new Set()
  while (pending.length > 0) {
    const packageName = pending.shift()
    if (!packageName || packageName.startsWith('@holo-js/') || visited.has(packageName)) {
      continue
    }
    if (options.includeAppDependencies === false && appDependencyNames.has(packageName)) {
      continue
    }
    visited.add(packageName)
    const source = resolveInstalledPackageRoot(sourceAppRoot, packageName)
    if (!source) {
      continue
    }
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    pending.push(...listManifestDependencyNames(manifest))
    const target = join(nodeModulesRoot, ...packageName.split('/'))
    if (existsSync(target) && !options.replaceExisting) {
      continue
    }
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter(path) {
        return path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}/`)
      },
    })
  }
}

async function createFrameworkNodeModules(sourceAppRoot, appRoot, stagedNodeModules) {
  const nodeModulesRoot = join(appRoot, 'node_modules')
  const sourceNodeModules = join(sourceAppRoot, 'node_modules')
  const sourceBin = join(sourceNodeModules, '.bin')
  await cp(sourceNodeModules, nodeModulesRoot, {
    recursive: true,
    dereference: true,
    filter(path) {
      const relative = path.slice(sourceNodeModules.length).replace(/^\//, '')
      const segments = relative.split('/')
      if (['.bin', '.bun', '@holo-js'].includes(segments[0])) {
        return false
      }
      return !segments.slice(1).includes('node_modules')
    },
  })
  await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, stagedNodeModules)
  await rm(join(nodeModulesRoot, '@holo-js'), { recursive: true, force: true })
  await cp(join(stagedNodeModules, '@holo-js'), join(nodeModulesRoot, '@holo-js'), {
    recursive: true,
    dereference: true,
  })
  const binRoot = join(nodeModulesRoot, '.bin')
  await mkdir(binRoot, { recursive: true })
  for (const binary of await readdir(sourceBin)) {
    const sourceBinary = join(sourceBin, binary)
    const targetBinary = join(binRoot, binary)
    try {
      await symlink(await readlink(sourceBinary), targetBinary)
      continue
    } catch {
      try {
        await cp(await realpath(sourceBinary), targetBinary)
      } catch {
        continue
      }
    }
  }
  const holoBinary = join(binRoot, 'holo')
  await rm(holoBinary, { force: true })
  await symlink(join(nodeModulesRoot, '@holo-js/cli/dist/bin/holo.mjs'), holoBinary)
}

async function createLinkedFrameworkNodeModules(sourceAppRoot, appRoot, stagedNodeModules) {
  const sourceNodeModules = join(sourceAppRoot, 'node_modules')
  const nodeModulesRoot = join(appRoot, 'node_modules')
  await mkdir(nodeModulesRoot, { recursive: true })
  for (const entry of await readdir(sourceNodeModules)) {
    if (entry === '.bin' || entry === '@holo-js') {
      continue
    }
    if (entry.startsWith('@')) {
      const sourceScope = join(sourceNodeModules, entry)
      const targetScope = join(nodeModulesRoot, entry)
      await mkdir(targetScope, { recursive: true })
      for (const packageName of await readdir(sourceScope)) {
        await symlink(join(sourceScope, packageName), join(targetScope, packageName))
      }
      continue
    }
    await symlink(join(sourceNodeModules, entry), join(nodeModulesRoot, entry))
  }
  await cp(join(stagedNodeModules, '@holo-js'), join(nodeModulesRoot, '@holo-js'), {
    recursive: true,
    dereference: true,
  })
  await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, stagedNodeModules, {
    includeAppDependencies: false,
    replaceExisting: true,
  })
  const binRoot = join(nodeModulesRoot, '.bin')
  await mkdir(binRoot, { recursive: true })
  for (const binary of await readdir(join(sourceNodeModules, '.bin'))) {
    if (binary === 'holo') {
      continue
    }
    await symlink(join(sourceNodeModules, '.bin', binary), join(binRoot, binary))
  }
  await symlink(join(nodeModulesRoot, '@holo-js/cli/dist/bin/holo.mjs'), join(binRoot, 'holo'))
}

async function buildFrameworkCopies(tempRoot, stagedNodeModules) {
  for (const app of frameworkApps) {
    const sourceAppRoot = join(rootDir, app.source)
    const appRoot = join(tempRoot, `framework-${app.name}`)
    await copyFrameworkApp(sourceAppRoot, appRoot)
    if (app.name === 'next') {
      await createFrameworkNodeModules(sourceAppRoot, appRoot, stagedNodeModules)
    } else {
      await createLinkedFrameworkNodeModules(sourceAppRoot, appRoot, stagedNodeModules)
    }
    run(appRoot, 'bun', ['run', 'prepare'])
    run(appRoot, 'bun', ['run', 'build'])
    await rm(appRoot, { recursive: true, force: true })
  }
}

export async function validatePublishedPackageSmoke(options = {}) {
  const rootManifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'))
  const catalog = rootManifest.workspaces?.catalog
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }
  if (!options.skipBuild) {
    run(rootDir, 'bun', ['run', '--filter', '@holo-js/*', '--sequential', 'build'])
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'holo-published-package-smoke-'))
  try {
    const packages = await readPackageManifests()
    const stagedNodeModules = await stagePackages(tempRoot, packages, catalog)
    await linkExternalDependencies(stagedNodeModules)
    await verifyPackageImports(tempRoot, packages)
    await buildFrameworkCopies(tempRoot, stagedNodeModules)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validatePublishedPackageSmoke({ skipBuild: process.argv.includes('--skip-build') })
}
