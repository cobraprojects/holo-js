import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveReleaseManifest } from './release-manifests.mjs'
import { collectPackageManifestFailures } from './validate-dependency-version-policy.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const interruptSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
let activePublish

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

export async function withResolvedCatalogManifests(callback, root = repoRoot, options = {}) {
  const rootManifest = await readJson(join(root, 'package.json'))
  const catalog = rootManifest.workspaces?.catalog
  if (!isObject(catalog)) {
    throw new Error('Root package.json is missing workspaces.catalog.')
  }

  const failures = await collectPackageManifestFailures(root)
  if (failures.length > 0) throw new Error(failures.join('\n'))

  const packageManifestPaths = await listPackageManifestPaths(root)
  const originalManifests = new Map()
  let callbackError

  let pendingWrites = Promise.resolve()
  let shutdown
  const stopAndRestore = async (signal) => {
    try {
      await options.onInterrupt?.(signal)
    } catch (error) {
      console.error(error)
    }
    await pendingWrites.catch(() => {})
    for (const [manifestPath, contents] of originalManifests) {
      try {
        writeFileSync(manifestPath, contents)
      } catch (error) {
        console.error(`Failed to restore ${manifestPath}: ${error.message}`)
      }
    }
  }
  const restoreOnInterrupt = async (signal) => {
    shutdown ??= stopAndRestore(signal)
    await shutdown
    for (const interruptSignal of interruptSignals) {
      process.removeListener(interruptSignal, restoreOnInterrupt)
    }
    process.kill(process.pid, signal)
  }
  for (const signal of interruptSignals) {
    process.on(signal, restoreOnInterrupt)
  }

  try {
    for (const manifestPath of packageManifestPaths) {
      const original = await readFile(manifestPath, 'utf8')
      originalManifests.set(manifestPath, original)
      const resolved = resolveReleaseManifest(JSON.parse(original), catalog)
      pendingWrites = writeFile(manifestPath, `${JSON.stringify(resolved, null, 2)}\n`)
      await pendingWrites
    }

    await callback()
  } catch (error) {
    callbackError = error
  }

  try {
    const manifestEntries = [...originalManifests]
    pendingWrites = Promise.allSettled(manifestEntries.map(([manifestPath, contents]) => (
      writeFile(manifestPath, contents)
    )))
    const restoreResults = await pendingWrites
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
  } finally {
    for (const signal of interruptSignals) {
      process.removeListener(signal, restoreOnInterrupt)
    }
  }
  if (callbackError) {
    throw callbackError
  }
}

function runChangesetPublish() {
  const changesetBinary = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'changeset.cmd' : 'changeset')

  return new Promise((resolvePublish, rejectPublish) => {
    const child = spawn(changesetBinary, ['publish'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    activePublish = child

    child.on('error', (error) => {
      activePublish = undefined
      rejectPublish(error)
    })
    child.on('close', (code) => {
      activePublish = undefined
      resolvePublish(code ?? 1)
    })
  })
}

async function stopActivePublish(signal) {
  if (!activePublish) return

  const exited = once(activePublish, 'close')
  activePublish.kill(signal)
  await exited
}

async function publishWithResolvedCatalogs() {
  let publishStatus = 0
  validateNpmPublishAuthentication()

  await withResolvedCatalogManifests(async () => {
    publishStatus = await runChangesetPublish()
  }, repoRoot, { onInterrupt: stopActivePublish })

  return publishStatus
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--preflight')) {
    validateNpmPublishAuthentication()
    process.exit(0)
  }

  process.exit(await publishWithResolvedCatalogs())
}
