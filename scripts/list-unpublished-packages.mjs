import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registryUrl = 'https://registry.npmjs.org'

async function listPublishablePackages(root) {
  const packagesDirectory = join(root, 'packages')
  const entries = await readdir(packagesDirectory, { withFileTypes: true })
  const packages = []
  for (const entry of entries.filter(candidate => candidate.isDirectory())) {
    const manifestPath = join(packagesDirectory, entry.name, 'package.json')
    try {
      await access(manifestPath)
    } catch {
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.private === true) continue
    packages.push({ name: manifest.name, version: manifest.version })
  }

  return packages
}

async function isVersionOnRegistry(name, version, fetchImpl) {
  const response = await fetchImpl(`${registryUrl}/${name.replace('/', '%2F')}/${version}`, {
    headers: { Accept: 'application/json' },
  })
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`npm registry responded ${response.status} for ${name}@${version}.`)
  }

  return true
}

export async function listUnpublishedPackages({ root = repoRoot, fetchImpl = fetch } = {}) {
  const unpublished = []
  for (const { name, version } of await listPublishablePackages(root)) {
    if (!await isVersionOnRegistry(name, version, fetchImpl)) unpublished.push(`${name}@${version}`)
  }

  return unpublished
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const specifier of await listUnpublishedPackages()) console.log(specifier)
  } catch (error) {
    console.error(`::error title=npm registry check failed::${error.message}`)
    process.exit(1)
  }
}
