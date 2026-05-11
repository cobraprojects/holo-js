import { spawnSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function listPackageManifestPaths(root = repoRoot) {
  const packageDirectory = join(root, 'packages')
  const entries = await readdir(packageDirectory, { withFileTypes: true })

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(packageDirectory, entry.name, 'package.json'))
}

export function resolveCatalogRangesInManifest(manifest, catalog) {
  const resolvedManifest = structuredClone(manifest)

  for (const sectionName of dependencySections) {
    const section = resolvedManifest[sectionName]
    if (!isObject(section)) {
      continue
    }

    for (const [packageName, version] of Object.entries(section)) {
      if (version !== 'catalog:') {
        continue
      }

      const resolvedVersion = catalog[packageName]
      if (typeof resolvedVersion !== 'string') {
        throw new Error(`Cannot resolve catalog range for ${sectionName}.${packageName}.`)
      }

      section[packageName] = resolvedVersion
    }
  }

  return resolvedManifest
}

export async function withResolvedCatalogManifests(callback, root = repoRoot) {
  const rootManifest = await readJson(join(root, 'package.json'))
  const catalog = rootManifest.workspaces?.catalog
  if (!isObject(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }

  const packageManifestPaths = await listPackageManifestPaths(root)
  const originalManifests = new Map()

  try {
    for (const manifestPath of packageManifestPaths) {
      const original = await readFile(manifestPath, 'utf8')
      originalManifests.set(manifestPath, original)
      const resolved = resolveCatalogRangesInManifest(JSON.parse(original), catalog)
      await writeFile(manifestPath, `${JSON.stringify(resolved, null, 2)}\n`)
    }

    await callback()
  } finally {
    await Promise.all([...originalManifests].map(([manifestPath, contents]) => (
      writeFile(manifestPath, contents)
    )))
  }
}

async function publishWithResolvedCatalogs() {
  let publishStatus = 0

  await withResolvedCatalogManifests(async () => {
    const result = spawnSync('changeset', ['publish'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })

    if (result.error) {
      throw result.error
    }

    publishStatus = result.status ?? 1
  })

  return publishStatus
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await publishWithResolvedCatalogs())
}
