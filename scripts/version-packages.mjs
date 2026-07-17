import { spawnSync } from 'node:child_process'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCatalogRangesInManifest } from './publish-with-resolved-catalogs.mjs'
import { syncWorkspaceCatalogVersions } from './sync-workspace-catalog-versions.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function listPackageManifestPaths(root) {
  const packageDirectory = join(root, 'packages')
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  const manifestPaths = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const manifestPath = join(packageDirectory, entry.name, 'package.json')
      try {
        await access(manifestPath)
        return manifestPath
      } catch {
        return null
      }
    }))

  return manifestPaths.filter(manifestPath => typeof manifestPath === 'string')
}

function restoreCatalogRanges(manifest, originalManifest) {
  for (const sectionName of dependencySections) {
    const originalSection = originalManifest[sectionName]
    const currentSection = manifest[sectionName]
    if (!originalSection || typeof originalSection !== 'object' || !currentSection || typeof currentSection !== 'object') {
      continue
    }

    for (const [packageName, version] of Object.entries(originalSection)) {
      if (version === 'catalog:' && Object.hasOwn(currentSection, packageName)) {
        currentSection[packageName] = 'catalog:'
      }
    }
  }

  return manifest
}

function resolveVersionCatalogRanges(manifest, catalog, workspacePackageNames) {
  const resolvedManifest = resolveCatalogRangesInManifest(manifest, catalog)
  const originalPeerDependencies = manifest.peerDependencies
  const resolvedPeerDependencies = resolvedManifest.peerDependencies
  if (!originalPeerDependencies || typeof originalPeerDependencies !== 'object' || !resolvedPeerDependencies || typeof resolvedPeerDependencies !== 'object') {
    return resolvedManifest
  }

  for (const [packageName, version] of Object.entries(originalPeerDependencies)) {
    if (version === 'catalog:' && workspacePackageNames.has(packageName)) {
      resolvedPeerDependencies[packageName] = '*'
    }
  }

  return resolvedManifest
}

export async function versionPackages(options = {}) {
  const root = options.root ?? repoRoot
  const runChangeset = options.runChangeset ?? (() => {
    const changesetBinary = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'changeset.cmd' : 'changeset')
    const result = spawnSync(changesetBinary, ['version'], {
      cwd: root,
      stdio: 'inherit',
    })

    if (result.error) {
      throw result.error
    }

    if (result.status !== 0) {
      throw new Error(`Changesets versioning failed with exit code ${result.status ?? 1}.`)
    }
  })
  const rootManifest = await readJson(join(root, 'package.json'))
  const catalog = rootManifest.workspaces?.catalog
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }

  const manifestPaths = await listPackageManifestPaths(root)
  const originalManifests = new Map()
  let changesetCompleted = false

  try {
    for (const manifestPath of manifestPaths) {
      const originalContents = await readFile(manifestPath, 'utf8')
      const originalManifest = JSON.parse(originalContents)
      originalManifests.set(manifestPath, { originalContents, originalManifest })
    }

    const workspacePackageNames = new Set([...originalManifests.values()]
      .map(({ originalManifest }) => originalManifest.name)
      .filter(packageName => typeof packageName === 'string'))

    for (const [manifestPath, { originalManifest }] of originalManifests) {
      const resolvedManifest = resolveVersionCatalogRanges(originalManifest, catalog, workspacePackageNames)
      await writeFile(manifestPath, `${JSON.stringify(resolvedManifest, null, 2)}\n`, 'utf8')
    }

    await runChangeset()
    changesetCompleted = true

    for (const [manifestPath, { originalManifest }] of originalManifests) {
      const versionedManifest = await readJson(manifestPath)
      const restoredManifest = restoreCatalogRanges(versionedManifest, originalManifest)
      await writeFile(manifestPath, `${JSON.stringify(restoredManifest, null, 2)}\n`, 'utf8')
    }

    await syncWorkspaceCatalogVersions(root)
  } catch (error) {
    if (!changesetCompleted) {
      await Promise.all([...originalManifests].map(([manifestPath, { originalContents }]) => (
        writeFile(manifestPath, originalContents, 'utf8')
      )))
    }
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await versionPackages()
}
