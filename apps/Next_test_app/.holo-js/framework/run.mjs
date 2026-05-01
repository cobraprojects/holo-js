import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const mode = process.argv[2]
const manifestPath = fileURLToPath(new URL('./project.json', import.meta.url))
const projectRoot = resolve(dirname(manifestPath), '../..')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const framework = String(manifest.framework ?? '')
const commandName = "next"
const commandArgs = mode === 'dev'
  ? ['dev']
  : mode === 'build'
    ? framework === 'sveltekit' ? ['build', '--logLevel', 'error'] : ['build']
    : undefined

if (!commandArgs) {
  console.error(`[holo] Unknown framework runner mode: ${String(mode)}`)
  process.exit(1)
}

const binaryPath = resolve(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? `${commandName}.cmd` : commandName,
)

const suppressedOutput = framework === 'sveltekit'
  ? new Set([
      '"try_get_request_store" is imported from external module "@sveltejs/kit/internal/server" but never used in ".svelte-kit/adapter-node/index.js".',
    ])
  : new Set()

function pipeOutput(stream, target, onLine) {
  if (!stream) {
    return
  }

  let buffered = ''
  stream.on('data', (chunk) => {
    buffered += chunk.toString()
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      onLine?.(line)
      if (!suppressedOutput.has(line)) {
        target.write(`${line}\n`)
      }
    }
  })

  stream.on('end', () => {
    if (buffered.length > 0) {
      onLine?.(buffered)
    }
    if (buffered.length > 0 && !suppressedOutput.has(buffered)) {
      target.write(buffered)
    }
  })
}

function extractNextConflictInfo(lines) {
  if (framework !== 'next' || mode !== 'dev') {
    return undefined
  }

  if (!lines.some(line => line.includes('Another next dev server is already running.'))) {
    return undefined
  }

  let pid
  let dir

  for (const line of lines) {
    const match = line.match(/^- PID:\s+(\d+)\s*$/)
    if (match) {
      pid = Number.parseInt(match[1], 10)
      continue
    }

    const dirMatch = line.match(/^- Dir:\s+(.+?)\s*$/)
    if (dirMatch) {
      dir = dirMatch[1]
    }
  }

  return typeof pid === 'number' ? { pid, dir } : undefined
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        return true
      }
      throw error
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return false
}

function inspectProcess(pid) {
  try {
    if (process.platform === 'linux' && existsSync(`/proc/${pid}`)) {
      return {
        cwd: readlinkSync(`/proc/${pid}/cwd`),
        args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\u0000', ' ').trim(),
      }
    }
  } catch {}

  try {
    return {
      args: execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
      }).trim(),
    }
  } catch {
    return undefined
  }
}

function isOwnedNextDevServer(pid, reportedDir) {
  const expectedDir = typeof reportedDir === 'string' ? resolve(reportedDir) : undefined
  if (expectedDir && expectedDir !== projectRoot) {
    return false
  }

  const details = inspectProcess(pid)
  if (!details) {
    return expectedDir === projectRoot
  }

  const argsMatch = details.args.includes('next') && details.args.includes('dev')
  const cwdMatches = typeof details.cwd === 'string' && resolve(details.cwd) === projectRoot
  const argsReferenceProject = details.args.includes(projectRoot)

  return argsMatch && (cwdMatches || argsReferenceProject || expectedDir === projectRoot)
}

async function stopStaleNextDevServer(pid, reportedDir) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false
  }

  if (!isOwnedNextDevServer(pid, reportedDir)) {
    return false
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return true
    }
    return false
  }

  return waitForProcessExit(pid)
}

if (!existsSync(binaryPath)) {
  console.error(`[holo] Missing framework binary "${commandName}" for "${framework}". Run your package manager install first.`)
  process.exit(1)
}

let child = null
let forwardedSignal = null

function detachSignalForwarders() {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

function forwardSignal(signal) {
  if (forwardedSignal || !child || child.exitCode !== null) {
    return
  }

  forwardedSignal = signal
  child.kill(signal)
}

function onSigint() {
  detachSignalForwarders()
  forwardSignal('SIGINT')
}

function onSigterm() {
  detachSignalForwarders()
  forwardSignal('SIGTERM')
}

process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)

async function run() {
  let restartedAfterConflict = false
  const maxStderrLines = 200

  while (true) {
    const stderrLines = []
    child = spawn(binaryPath, commandArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    forwardedSignal = null

    pipeOutput(child.stdout, process.stdout)
    pipeOutput(child.stderr, process.stderr, line => {
      if (stderrLines.length >= maxStderrLines) {
        stderrLines.shift()
      }
      stderrLines.push(line)
    })

    const result = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal }))
    })

    if (result.code === 0) {
      process.exit(0)
    }

    const conflictInfo = extractNextConflictInfo(stderrLines)
    if (!restartedAfterConflict && conflictInfo) {
      const stopped = await stopStaleNextDevServer(conflictInfo.pid, conflictInfo.dir)
      if (stopped) {
        restartedAfterConflict = true
        console.error(`[holo] Stopped stale Next dev server ${conflictInfo.pid}. Restarting dev server.`)
        continue
      }
    }

    if (result.signal) {
      detachSignalForwarders()
      process.kill(process.pid, result.signal)
    } else {
      process.exit(result.code ?? 1)
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
