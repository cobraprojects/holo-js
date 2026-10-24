import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function stopExampleAppProcess(child, signal = 'SIGTERM') {
  if (!child) return
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('close', resolve))
  const kill = signal => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  kill(signal)
  let deadline
  try {
    await Promise.race([
      (async () => {
        await closed
        if (process.platform === 'win32') return
        while (true) {
          try {
            process.kill(-child.pid, 0)
          } catch {
            return
          }
          await delay(25)
        }
      })(),
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`Process ${child.spawnargs.join(' ')} did not stop after ${signal}`)), 10000)
      }),
    ])
  } catch (error) {
    kill('SIGKILL')
    await closed
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

// Every descendant of an app journey inherits its environment, including ones spawned with
// `detached: true` into their own process group, so a run id in the environment finds the whole tree.
export const exampleAppRunVariable = 'HOLO_EXAMPLE_APP_RUN'

export async function listTaggedProcesses(runId) {
  const tag = `${exampleAppRunVariable}=${runId}`
  if (process.platform === 'linux') {
    const found = []
    for (const entry of await readdir('/proc')) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid === process.pid) continue
      const environment = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
      if (!environment.split('\0').includes(tag)) continue
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
      found.push({ pid, command: command.split('\0').join(' ').trim() })
    }
    return found
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-A', '-o', 'pid=,command='], { maxBuffer: 64 * 1024 * 1024 })
    const pids = stdout.split('\n')
      .map(line => line.trim().match(/^(\d+) (.*)$/))
      .filter(match => match && Number(match[1]) !== process.pid && match[2].split(' ').includes(tag))
      .map(match => Number(match[1]))
    if (pids.length === 0) return []
    const { stdout: commands } = await execFileAsync('ps', ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')]).catch(error => error)
    return (commands ?? '').split('\n').map(line => line.trim().match(/^(\d+) (.*)$/)).filter(Boolean)
      .map(match => ({ pid: Number(match[1]), command: match[2] }))
  }
  throw new Error(`Listing tagged processes is not supported on ${process.platform}.`)
}

// Stops every process carrying the run id, including any it spawns meanwhile, and returns the ones found running.
export async function stopTaggedProcesses(runId) {
  const found = new Map()
  const signalErrors = []
  let remaining = await listTaggedProcesses(runId)
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const signalled = new Set()
    const deadline = Date.now() + 10000
    while (remaining.length > 0 && Date.now() < deadline) {
      for (const running of remaining) {
        found.set(running.pid, running)
        if (signalled.has(running.pid)) continue
        signalled.add(running.pid)
        try {
          process.kill(running.pid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH') signalErrors.push(`${signal} ${running.pid}: ${error.message}`)
        }
      }
      await delay(25)
      remaining = await listTaggedProcesses(runId)
    }
  }
  if (remaining.length > 0) {
    throw new Error([
      `Processes of example app run ${runId} survived SIGKILL:`,
      ...remaining.map(({ pid, command }) => `  ${pid} ${command}`),
      ...signalErrors.map(error => `  ${error}`),
    ].join('\n'))
  }
  return [...found.values()]
}

// Settles once the stream has closed, including when it was already destroyed, where end() never calls back.
export function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    const settle = () => stream.errored ? reject(stream.errored) : resolve()
    if (stream.closed) {
      settle()
      return
    }
    stream.once('error', () => {})
    stream.once('close', settle)
    stream.end()
  })
}
