import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
// The marker lives inside dist, so a rebuild that clears dist also clears the marker until the build succeeds again.
const BUILD_MARKER = posix.join('dist', '.holo-build-fingerprint')
const EXCLUDED_DIRECTORIES = new Set(['dist', 'node_modules', 'tests', 'coverage'])
// Repository-wide inputs that every package build reads, besides the tsconfig extends chain.
const SHARED_BUILD_FILES = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'scripts/build-libraries.mjs',
  'scripts/generate-cli-workspace-catalog.mjs',
  'scripts/workspace-build-fingerprint.mjs',
]

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function listBuildInputs(directory, prefix = '') {
  const files = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const relativePath = posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
      files.push(...listBuildInputs(directory, relativePath))
    } else {
      files.push(relativePath)
    }
  }
  return files.sort()
}

function resolveExtends(from, specifier) {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return resolve(dirname(from), specifier)
  return createRequire(from).resolve(specifier)
}

// Every tsconfig a package's build reads, following `extends` (relative or package specifiers) to the end of the chain.
function tsconfigChain(configPath, seen = new Set()) {
  const absolute = resolve(configPath)
  if (seen.has(absolute)) return []
  seen.add(absolute)
  const { config, error } = ts.readConfigFile(absolute, ts.sys.readFile)
  if (error) throw new Error(`Cannot read ${absolute}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  const parents = [config?.extends].flat().filter(value => typeof value === 'string')
  return [absolute, ...parents.flatMap(parent => tsconfigChain(resolveExtends(absolute, parent), seen))]
}

function repositoryKey(repositoryRoot, path) {
  const inside = relative(repositoryRoot, path)
  return inside.startsWith('..') || isAbsolute(inside) ? `external:${path}` : `repo:${inside.split(sep).join('/')}`
}

function sharedBuildInputs(repositoryRoot, directory) {
  const packageTsconfig = join(directory, 'tsconfig.json')
  const chain = existsSync(packageTsconfig) ? tsconfigChain(packageTsconfig) : []
  const paths = new Set([...SHARED_BUILD_FILES.map(file => join(repositoryRoot, file)), ...chain])
  return [...paths].map(path => ({ key: repositoryKey(repositoryRoot, path), path }))
}

/**
 * Hashes every input a package build reads: the package's own files (relative path and content, excluding dist,
 * node_modules, tests, coverage, and hidden entries), plus the repository-wide inputs and the tsconfig chain. A
 * missing input is hashed as absent, so deleting one also changes the fingerprint. Modification times are ignored.
 */
function workspaceBuildFingerprint(directory, repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const entries = [
    ...listBuildInputs(directory).map(file => ({ key: file, path: join(directory, file) })),
    ...sharedBuildInputs(repositoryRoot, directory),
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  const hash = createHash('sha256')
  for (const { key, path } of entries) {
    hash.update(key)
    hash.update('\0')
    hash.update(existsSync(path) ? sha256(readFileSync(path)) : 'absent')
    hash.update('\n')
  }
  return hash.digest('hex')
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(exportTargets)
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets)
  return []
}

/**
 * The files the package manifest promises after a build. A dist with a recent marker but a missing entry point is not
 * a usable build.
 */
function requiredBuildOutputs(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const targets = [
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.typings,
    ...exportTargets(manifest.bin),
    ...exportTargets(manifest.exports),
  ]
  return [...new Set(targets
    .filter(target => typeof target === 'string' && target.startsWith('./dist/') && !target.includes('*'))
    .map(target => posix.normalize(target.slice(2))))]
}

export function isWorkspaceBuildCurrent(directory, repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const markerPath = join(directory, BUILD_MARKER)
  if (!existsSync(markerPath)) return false
  if (readFileSync(markerPath, 'utf8').trim() !== workspaceBuildFingerprint(directory, repositoryRoot)) return false
  return requiredBuildOutputs(directory).every(output => existsSync(join(directory, output)))
}

/** Call only after a successful build, so the marker never describes a partial build. */
export function writeWorkspaceBuildMarker(directory, repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, BUILD_MARKER), `${workspaceBuildFingerprint(directory, repositoryRoot)}\n`)
}
