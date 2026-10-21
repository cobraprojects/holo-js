import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveReleaseManifest } from './release-manifests.mjs'
import { collectPackageManifestFailures } from './validate-dependency-version-policy.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const interruptSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
let activeTree
const publishStopGraceMs = 5000

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

export function parseLinuxProcessStat(stat) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

  return { state: fields[0], pgrp: Number(fields[2]), startTime: Number(fields[19]) }
}

const processGroupProbePasses = 3

export function probeProcessGroup(pgid, readers) {
  let previous
  for (let pass = 0; pass < processGroupProbePasses; pass++) {
    const current = readProcessGroupPass(pgid, readers)
    if (current.live) return 'live'
    if (previous?.complete && current.complete && sameProcessGroupMembers(previous, current)) return 'gone'
    previous = current
  }

  return 'unsettled'
}

function readProcessGroupPass(pgid, readers) {
  const members = new Map()
  try {
    for (const pid of readers.listPids()) {
      const member = readers.readGroupMember(pid, pgid)
      if (!member) continue
      if (member.live) return { live: true, complete: true, members }
      members.set(pid, member.startTime)
    }
  } catch {
    return { live: false, complete: false, members }
  }

  return { live: false, complete: true, members }
}

function sameProcessGroupMembers(left, right) {
  if (left.members.size !== right.members.size) return false

  return [...left.members].every(([pid, startTime]) => right.members.get(pid) === startTime)
}

function isProcVanished(error) {
  return error.code === 'ENOENT' || error.code === 'ESRCH'
}

function readOptionalProcFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isProcVanished(error)) return null
    throw error
  }
}

function readOptionalProcDirectory(path) {
  try {
    return readdirSync(path)
  } catch (error) {
    if (isProcVanished(error)) return null
    throw error
  }
}

const linuxProcessReaders = {
  listPids() {
    return readdirSync('/proc').filter(entry => /^\d+$/.test(entry))
  },
  readGroupMember(pid, pgid) {
    const stat = readOptionalProcFile(join('/proc', pid, 'stat'))
    if (stat === null) return null

    const leader = parseLinuxProcessStat(stat)
    if (leader.pgrp !== pgid) return null

    const taskIds = readOptionalProcDirectory(join('/proc', pid, 'task'))
    if (taskIds === null) return null

    let live = false
    for (const taskId of taskIds) {
      const taskStat = readOptionalProcFile(join('/proc', pid, 'task', taskId, 'stat'))
      if (taskStat !== null && parseLinuxProcessStat(taskStat).state !== 'Z') live = true
    }
    return { startTime: leader.startTime, live }
  },
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
  } catch (error) {
    return error.code !== 'ESRCH'
  }

  if (process.platform !== 'linux') return true

  try {
    return probeProcessGroup(pid, linuxProcessReaders) !== 'gone'
  } catch {
    return true
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForProcessGroupExit(pid, timeoutMs = Infinity) {
  const deadline = Date.now() + timeoutMs
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

export function startProcessTree(command, args, options = {}) {
  const posix = process.platform !== 'win32'
  const graceMs = options.graceMs ?? publishStopGraceMs
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    detached: posix,
  })
  const leaderClosed = new Promise((resolveClose, rejectClose) => {
    child.on('error', rejectClose)
    child.on('close', code => resolveClose(code ?? 1))
  })
  const exited = leaderClosed.then(async (code) => {
    if (posix) await waitForProcessGroupExit(child.pid)
    return code
  })

  const signalTree = (signal) => {
    if (!posix) {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      return
    }

    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }

  let stopping
  return {
    exited,
    stop(signal) {
      stopping ??= (async () => {
        signalTree(signal)
        if (!posix) {
          await leaderClosed
          return
        }
        if (await waitForProcessGroupExit(child.pid, graceMs)) return

        signalTree('SIGKILL')
        await waitForProcessGroupExit(child.pid)
      })()
      return stopping
    },
  }
}

async function runChangesetPublish() {
  const changesetBinary = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'changeset.cmd' : 'changeset')
  const tree = startProcessTree(changesetBinary, ['publish'])
  activeTree = tree

  try {
    return await tree.exited
  } finally {
    activeTree = undefined
  }
}

async function stopActivePublish(signal) {
  await activeTree?.stop(signal)
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
