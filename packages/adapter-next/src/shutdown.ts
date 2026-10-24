import { constants } from 'node:os'
import type { HoloErrorReporter } from '@holo-js/kernel/error-reporting'

type TerminationSignal = 'SIGINT' | 'SIGTERM'
type ExitCode = Parameters<typeof process.exit>[0]

export type NextShutdownOptions = {
  readonly close: () => Promise<void>
  readonly report: HoloErrorReporter
}

const SHUTDOWN_DEADLINE_MS = 30_000
const TERMINATION_SIGNALS: readonly TerminationSignal[] = ['SIGINT', 'SIGTERM']

type ShutdownState = {
  installed: boolean
  options?: NextShutdownOptions
  closed?: NextShutdownOptions
  signal?: TerminationSignal
  closing?: Promise<void>
  uninstall?: () => void
}

function shutdownState(): ShutdownState {
  const globalState = globalThis as typeof globalThis & { __holoNextShutdown__?: ShutdownState }
  globalState.__holoNextShutdown__ ??= { installed: false }
  return globalState.__holoNextShutdown__
}

function closeCurrent(): Promise<void> {
  const state = shutdownState()
  state.closing ??= closeUntilStable().finally(() => {
    state.closing = undefined
  })
  return state.closing
}

async function closeUntilStable(): Promise<void> {
  const state = shutdownState()
  while (state.options && state.options !== state.closed) {
    const current = state.options
    state.closed = current
    try {
      await current.close()
    } catch (error) {
      current.report(error, { capability: 'next', operation: 'shutdown' })
    }
  }
}

export function installNextShutdown(options: NextShutdownOptions): () => void {
  const state = shutdownState()
  state.options = options
  if (state.signal) void closeCurrent()
  if (state.installed) return state.uninstall ?? (() => {})

  state.installed = true
  const exit = process.exit
  const onSignal = (signal: TerminationSignal) => {
    if (state.signal) return
    state.signal = signal
    const code = 128 + constants.signals[signal]
    process.exitCode = code
    const deadline = setTimeout(() => exit.call(process, code), SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    // Without another handler the signal's default action ends the process, so Holo ends it once closed
    // instead of waiting for handles it does not own, such as Next's static export worker timers.
    const ownsTermination = process.listenerCount(signal) === 1
    setImmediate(() => void closeCurrent().then(() => {
      if (ownsTermination) exit.call(process, code)
    }))
  }
  const listeners = TERMINATION_SIGNALS.map(signal => [signal, () => onSignal(signal)] as const)
  const patchedExit = ((code?: ExitCode) => {
    if (!state.signal) return exit.call(process, code)
    void closeCurrent().then(() => exit.call(process, code))
  }) as typeof process.exit

  process.exit = patchedExit
  for (const [signal, listener] of listeners) process.prependListener(signal, listener)

  function uninstall(): void {
    if (process.exit === patchedExit) process.exit = exit
    for (const [signal, listener] of listeners) process.removeListener(signal, listener)
    state.installed = false
    state.signal = undefined
    state.closing = undefined
    state.closed = undefined
  }

  state.uninstall = uninstall
  return uninstall
}
