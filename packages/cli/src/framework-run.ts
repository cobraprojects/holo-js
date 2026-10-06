import { type spawn, spawnSync } from 'node:child_process'
import type { IoStreams, PackageManagerCommand, SpawnProcessLike } from './cli-types'

type FrameworkRunResult = (
  | { kind: 'close', code: number | null }
  | { kind: 'error', error: Error }
) & {
  readonly shutdownSignal?: NodeJS.Signals
  readonly restartRequested: boolean
}

function terminateChildProcess(child: SpawnProcessLike, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill?.(signal)
    return
  }

  const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  if (result.status !== 0) {
    child.kill?.(signal)
  }
}

export function launchFrameworkRun(
  io: IoStreams,
  projectRoot: string,
  invocation: PackageManagerCommand,
  serverArgs: readonly string[],
  spawnProcess: typeof spawn,
  onShutdown?: () => void,
): { readonly completion: Promise<FrameworkRunResult>, restart(): void } {
  const child = spawnProcess(invocation.command, [...invocation.args, ...serverArgs], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as SpawnProcessLike
  let restartRequested = false
  let shutdownSignal: NodeJS.Signals | undefined
  let settled = false
  let finish: (result: FrameworkRunResult) => void
  const completion = new Promise<FrameworkRunResult>((resolvePromise) => {
    finish = resolvePromise
  })
  const forwardOutput = (chunk: string | Uint8Array) => io.stdout.write(chunk)
  const forwardError = (chunk: string | Uint8Array) => io.stderr.write(chunk)
  const settle = (result: { kind: 'close', code: number | null } | { kind: 'error', error: Error }) => {
    if (settled) return

    settled = true
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    child.stdout?.off('data', forwardOutput)
    child.stderr?.off('data', forwardError)
    if (child.stdin) io.stdin.unpipe(child.stdin)
    finish({ ...result, restartRequested, ...(shutdownSignal ? { shutdownSignal } : {}) })
  }
  const terminate = (signal: NodeJS.Signals) => {
    try {
      terminateChildProcess(child, signal)
    } catch (error) {
      settle({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  const shutdown = (signal: NodeJS.Signals) => {
    if (settled || shutdownSignal) return

    shutdownSignal = signal
    onShutdown?.()
    terminate(signal)
  }
  function onSigint() {
    shutdown('SIGINT')
  }
  function onSigterm() {
    shutdown('SIGTERM')
  }

  child.on('error', error => settle({ kind: 'error', error }))
  child.on('close', code => settle({ kind: 'close', code }))
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  child.stdout?.on('data', forwardOutput)
  child.stderr?.on('data', forwardError)
  if (child.stdin) io.stdin.pipe(child.stdin)

  return {
    completion,
    restart() {
      if (settled || restartRequested || shutdownSignal || (!child.kill && child.pid === undefined)) return

      restartRequested = true
      terminate('SIGTERM')
    },
  }
}
