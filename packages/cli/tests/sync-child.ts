import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

const SYNC_CHILD_TIMEOUT_MS = 120_000
const SYNC_CHILD_OUTPUT_TAIL_LENGTH = 4_000
const TREE_KILL_TIMEOUT_MS = 10_000

function syncChildOutputTail(output: string | null): string {
  const text = output ?? ''
  return text.length > SYNC_CHILD_OUTPUT_TAIL_LENGTH ? `...${text.slice(-SYNC_CHILD_OUTPUT_TAIL_LENGTH)}` : text
}

export function killSyncChildTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
  if (platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      timeout: TREE_KILL_TIMEOUT_MS,
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
}

export function spawnSyncBounded(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const startedAt = Date.now()
  const spawnOptions: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    ...options,
    encoding: 'utf8',
    detached: process.platform !== 'win32',
    timeout: SYNC_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }
  const result = spawnSync(command, args, spawnOptions)
  killSyncChildTree(result.pid)
  if (result.error || result.signal) {
    throw new Error([
      `Synchronous child process did not complete: ${[command, ...args].join(' ')}`,
      `cwd: ${String(options.cwd ?? process.cwd())}`,
      `elapsed: ${Date.now() - startedAt}ms (limit ${SYNC_CHILD_TIMEOUT_MS}ms)`,
      `error: ${result.error?.message ?? 'none'}`,
      `signal: ${result.signal ?? 'none'}`,
      `stdout tail:\n${syncChildOutputTail(result.stdout)}`,
      `stderr tail:\n${syncChildOutputTail(result.stderr)}`,
    ].join('\n'))
  }
  return result
}
