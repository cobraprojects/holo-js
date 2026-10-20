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
  signal?: TerminationSignal
  closing?: Promise<void>
  uninstall?: () => void
}

function shutdownState(): ShutdownState {
  const globalState = globalThis as typeof globalThis & { __holoNextShutdown__?: ShutdownState }
  globalState.__holoNextShutdown__ ??= { installed: false }
  return globalState.__holoNextShutdown__
}

export function installNextShutdown(options: NextShutdownOptions): () => void {
  const state = shutdownState()
  state.options = options
  if (state.installed) return state.uninstall ?? (() => {})

  state.installed = true
  const exit = process.exit
  const closeThenExit = (code: ExitCode): void => {
    state.closing ??= (async () => {
      try {
        await state.options?.close()
      } catch (error) {
        state.options?.report(error, { capability: 'next', operation: 'shutdown' })
      }
      exit(code)
    })()
  }

  const onSignal = (signal: TerminationSignal) => {
    if (state.signal) return
    state.signal = signal
    const code = 128 + constants.signals[signal]
    setTimeout(() => exit.call(process, code), SHUTDOWN_DEADLINE_MS)
    if (process.listenerCount(signal) === 1) closeThenExit(code)
  }
  const listeners = TERMINATION_SIGNALS.map(signal => [signal, () => onSignal(signal)] as const)
  const patchedExit = ((code?: ExitCode) => {
    if (!state.signal) return exit.call(process, code)
    closeThenExit(code)
  }) as typeof process.exit

  process.exit = patchedExit
  for (const [signal, listener] of listeners) process.prependListener(signal, listener)

  function uninstall(): void {
    if (process.exit === patchedExit) process.exit = exit
    for (const [signal, listener] of listeners) process.removeListener(signal, listener)
    state.installed = false
    state.signal = undefined
    state.closing = undefined
  }

  state.uninstall = uninstall
  return uninstall
}
