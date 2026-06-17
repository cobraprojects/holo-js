import { spawnSync } from 'node:child_process'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function normalizeProcessOutput(output) {
  if (typeof output === 'string') {
    return output.trim()
  }

  if (Buffer.isBuffer(output)) {
    return output.toString('utf8').trim()
  }

  return ''
}

export function validateNpmPublishAuthentication(options = {}) {
  const spawn = options.spawn ?? spawnSync
  const root = options.root ?? repoRoot
  const result = spawn(npmBinary, ['whoami'], {
    cwd: root,
    encoding: 'utf8',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    const output = [
      normalizeProcessOutput(result.stderr),
      normalizeProcessOutput(result.stdout),
    ].filter(Boolean).join('\n')
    const detail = output.length > 0 ? `\n\nnpm whoami output:\n${output}` : ''

    throw new Error([
      'Cannot publish Holo packages because npm authentication failed.',
      'Run `npm login` or configure an npm token with publish access to the @holo-js scope, then retry `bun run release`.',
    ].join('\n') + detail)
  }

  return normalizeProcessOutput(result.stdout)
}

async function listPackageManifestPaths(root = repoRoot) {
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
  let callbackError

  try {
    for (const manifestPath of packageManifestPaths) {
      const original = await readFile(manifestPath, 'utf8')
      originalManifests.set(manifestPath, original)
      const resolved = resolveCatalogRangesInManifest(JSON.parse(original), catalog)
      await writeFile(manifestPath, `${JSON.stringify(resolved, null, 2)}\n`)
    }

    await callback()
  } catch (error) {
    callbackError = error
  }

  const manifestEntries = [...originalManifests]
  const restoreResults = await Promise.allSettled(manifestEntries.map(([manifestPath, contents]) => (
    writeFile(manifestPath, contents)
  )))
  const restoreFailures = restoreResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return []
    }

    const manifestPath = manifestEntries[index]?.[0] ?? '<unknown>'
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    return [`${manifestPath}: ${reason}`]
  })
  if (restoreFailures.length > 0) {
    throw new Error(`Failed to restore ${restoreFailures.length} package manifest(s): ${restoreFailures.join('; ')}`)
  }
  if (callbackError) {
    throw callbackError
  }
}

async function publishWithResolvedCatalogs() {
  let publishStatus = 0
  validateNpmPublishAuthentication()

  await withResolvedCatalogManifests(async () => {
    const changesetBinary = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'changeset.cmd' : 'changeset')
    const result = spawnSync(changesetBinary, ['publish'], {
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
  if (process.argv.includes('--preflight')) {
    validateNpmPublishAuthentication()
    process.exit(0)
  }

  process.exit(await publishWithResolvedCatalogs())
}
