import { type spawn, spawnSync } from 'node:child_process'
import type { IoStreams, PackageManagerCommand, SpawnProcessLike } from './cli-types'

type FrameworkRunResult = (
  | { kind: 'close', code: number | null }
  | { kind: 'error', error: Error }
) & {
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

function launchFrameworkRun(
  io: IoStreams,
  projectRoot: string,
  invocation: PackageManagerCommand,
  serverArgs: readonly string[],
  spawnProcess: typeof spawn,
): { readonly completion: Promise<FrameworkRunResult>, restart(): void, shutdown(signal: NodeJS.Signals): void } {
  const child = spawnProcess(invocation.command, [...invocation.args, ...serverArgs], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as SpawnProcessLike
  let restartRequested = false
  let shutdownSignal: NodeJS.Signals | undefined
  let processError: Error | undefined
  let terminationRequested = false
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
    child.stdout?.off('data', forwardOutput)
    child.stderr?.off('data', forwardError)
    if (child.stdin) io.stdin.unpipe(child.stdin)
    finish({ ...result, restartRequested })
  }
  const terminate = (signal: NodeJS.Signals) => {
    terminationRequested = true
    try {
      terminateChildProcess(child, signal)
    } catch (error) {
      const terminationError = error instanceof Error ? error : new Error(String(error))
      processError ??= terminationError
      io.stderr.write(`Framework termination failed: ${terminationError.message}\n`)
    }
  }
  const shutdown = (signal: NodeJS.Signals) => {
    if (settled || shutdownSignal) return

    shutdownSignal = signal
    terminate(signal)
  }
  child.on('error', (error) => {
    if (settled) return

    processError ??= error
    if (terminationRequested) io.stderr.write(`Framework termination failed: ${error.message}\n`)
    else terminate('SIGTERM')
  })
  child.on('close', code => settle(processError ? { kind: 'error', error: processError } : { kind: 'close', code }))
  child.stdout?.on('data', forwardOutput)
  child.stderr?.on('data', forwardError)
  if (child.stdin) io.stdin.pipe(child.stdin)

  return {
    completion,
    shutdown,
    restart() {
      if (settled || processError || restartRequested || shutdownSignal || (!child.kill && child.pid === undefined)) return

      restartRequested = true
      terminate('SIGTERM')
    },
  }
}

export function createFrameworkSession(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn,
  onShutdown?: () => void,
): {
  readonly signal: AbortSignal
  launch(invocation: PackageManagerCommand, serverArgs: readonly string[]): ReturnType<typeof launchFrameworkRun>
  dispose(): void
} {
  const controller = new AbortController()
  let activeRun: ReturnType<typeof launchFrameworkRun> | undefined
  let shutdownSignal: NodeJS.Signals | undefined
  const shutdown = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return

    shutdownSignal = signal
    controller.abort()
    try {
      onShutdown?.()
    } finally {
      activeRun?.shutdown(signal)
    }
  }
  const onSigint = () => shutdown('SIGINT')
  const onSigterm = () => shutdown('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  return {
    signal: controller.signal,
    launch(invocation: PackageManagerCommand, serverArgs: readonly string[]) {
      controller.signal.throwIfAborted()
      activeRun = launchFrameworkRun(io, projectRoot, invocation, serverArgs, spawnProcess)
      if (shutdownSignal) activeRun.shutdown(shutdownSignal)
      return activeRun
    },
    dispose() {
      try {
        shutdown('SIGTERM')
      } finally {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigterm)
      }
    },
  }
}
