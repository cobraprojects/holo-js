import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'

// The marker lives inside dist, so a rebuild that clears dist also clears the marker until the build succeeds again.
const BUILD_MARKER = posix.join('dist', '.holo-build-fingerprint')
const EXCLUDED_DIRECTORIES = new Set(['dist', 'node_modules', 'tests', 'coverage'])

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

/**
 * Hashes the relative path and content of every package file that can feed a build, so an edit, an addition, a
 * deletion, or a changed build config all change the result. Modification times are ignored: a touch alone does not
 * change the fingerprint.
 */
function workspaceBuildFingerprint(directory) {
  const hash = createHash('sha256')
  for (const file of listBuildInputs(directory)) {
    hash.update(file)
    hash.update('\0')
    hash.update(createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'))
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

export function isWorkspaceBuildCurrent(directory) {
  const markerPath = join(directory, BUILD_MARKER)
  if (!existsSync(markerPath)) return false
  if (readFileSync(markerPath, 'utf8').trim() !== workspaceBuildFingerprint(directory)) return false
  return requiredBuildOutputs(directory).every(output => existsSync(join(directory, output)))
}

/** Call only after a successful build, so the marker never describes a partial build. */
export function writeWorkspaceBuildMarker(directory) {
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, BUILD_MARKER), `${workspaceBuildFingerprint(directory)}\n`)
}
