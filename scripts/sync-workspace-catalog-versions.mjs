import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { generateCliWorkspaceCatalog } from './generate-cli-workspace-catalog.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function listPackageManifestPaths(root = repoRoot) {
  const packageDirectory = join(root, 'packages')
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  const manifestPaths = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = join(packageDirectory, entry.name, 'package.json')
    try {
      await access(manifestPath)
      manifestPaths.push(manifestPath)
    } catch {
      continue
    }
  }

  return manifestPaths
}

export async function syncWorkspaceCatalogVersions(root = repoRoot) {
  const rootManifestPath = join(root, 'package.json')
  const rootManifest = await readJson(rootManifestPath)
  const catalog = rootManifest.workspaces?.catalog

  if (!isObject(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }

  const packageManifestPaths = await listPackageManifestPaths(root)
  for (const manifestPath of packageManifestPaths) {
    const manifest = await readJson(manifestPath)
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      continue
    }

    if (Object.hasOwn(catalog, manifest.name)) {
      catalog[manifest.name] = `^${manifest.version}`
    }
  }

  await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, 'utf8')
  await generateCliWorkspaceCatalog(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncWorkspaceCatalogVersions()
}
