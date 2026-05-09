import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
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

async function readWorkspaceCatalog() {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  if (!isObject(rootManifest.workspaces) || !isObject(rootManifest.workspaces.catalog)) {
    return new Set()
  }

  return new Set(Object.keys(rootManifest.workspaces.catalog))
}

async function listTrackedAppManifests() {
  const { stdout } = await execFileAsync('git', ['ls-files', 'apps/*/package.json'], {
    cwd: repoRoot,
  })

  return stdout
    .split('\n')
    .filter(Boolean)
    .map(filePath => join(repoRoot, filePath))
}

async function collectAppManifestFailures() {
  const catalogPackages = await readWorkspaceCatalog()
  const manifestPaths = await listTrackedAppManifests()
  const failures = []

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    for (const sectionName of dependencySections) {
      const section = manifest[sectionName]
      if (!isObject(section)) {
        continue
      }

      for (const [packageName, version] of Object.entries(section)) {
        if (packageName.startsWith('@holo-js/') && version !== 'workspace:*') {
          failures.push(`${manifestPath}: ${sectionName}.${packageName} must be "workspace:*" in committed apps, found "${version}".`)
          continue
        }

        if (!packageName.startsWith('@holo-js/') && catalogPackages.has(packageName) && version !== 'catalog:') {
          failures.push(`${manifestPath}: ${sectionName}.${packageName} must use "catalog:" in committed apps, found "${version}".`)
        }
      }
    }
  }

  return failures
}

async function collectScaffoldSourceFailures() {
  const scaffoldPath = join(repoRoot, 'packages/cli/src/project/scaffold/framework.ts')
  const source = await readFile(scaffoldPath, 'utf8')
  const renderStart = source.indexOf('export function renderScaffoldPackageJson')
  const renderEnd = source.indexOf('\nexport async function scaffoldProject', renderStart)

  if (renderStart === -1 || renderEnd === -1) {
    return [`${scaffoldPath}: could not locate renderScaffoldPackageJson for dependency policy validation.`]
  }

  const renderSource = source.slice(renderStart, renderEnd)
  const forbiddenRanges = ['workspace:', 'catalog:']
  const forbiddenRange = forbiddenRanges.find(range => renderSource.includes(range))
  if (forbiddenRange) {
    return [`${scaffoldPath}: generated user project manifests must not contain ${forbiddenRange} dependency ranges.`]
  }

  return []
}

const failures = [
  ...(await collectAppManifestFailures()),
  ...(await collectScaffoldSourceFailures()),
]

if (failures.length > 0) {
  console.error('Dependency version policy failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Dependency version policy validated.')
