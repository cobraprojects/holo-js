import type { HoloProjectPrepareChange } from '@holo-js/kernel'
import type { IoStreams, PackageManagerCommand } from './cli-types'
import type { createFrameworkSession } from './framework-run'

type FrameworkRestartOptions = {
  readonly session: ReturnType<typeof createFrameworkSession>
  readonly initialArgs: readonly string[]
  readonly invocation: PackageManagerCommand
  readonly io: IoStreams
  readonly prepare: (changes: readonly HoloProjectPrepareChange[]) => Promise<readonly string[]>
}

export function createFrameworkRestart({ session, initialArgs, invocation, io, prepare }: FrameworkRestartOptions): {
  observe(change: HoloProjectPrepareChange | (() => Promise<HoloProjectPrepareChange>)): void
  run(): Promise<void>
  shutdown(): Promise<void>
} {
  let serverArgs = initialArgs
  let classification = Promise.resolve()
  let pendingPrepare: Promise<void> | undefined
  let queued = false
  let requestRestart: (() => void) | undefined
  const pendingChanges = new Map<string, HoloProjectPrepareChange['kind']>()

  const enqueue = (change?: HoloProjectPrepareChange): void => {
    if (session.signal.aborted) return

    if (change) pendingChanges.set(change.path, change.kind)
    if (pendingPrepare) {
      queued = true
      return
    }

    const changes = [...pendingChanges.entries()]
      .map(([path, kind]) => ({ path, kind }))
      .sort((left, right) => left.path.localeCompare(right.path))
    pendingChanges.clear()
    pendingPrepare = prepare(changes)
      .then((args) => {
        session.signal.throwIfAborted()
        serverArgs = args
        requestRestart?.()
      })
      .catch((error) => {
        if (!session.signal.aborted) io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => {
        pendingPrepare = undefined
        if (queued) {
          queued = false
          enqueue()
        }
      })
  }

  const drain = async (): Promise<void> => {
    for (;;) {
      const pendingClassification = classification
      await pendingClassification
      await pendingPrepare
      if (pendingClassification === classification && !pendingPrepare) return
    }
  }

  return {
    observe(change) {
      if (session.signal.aborted) return

      if (typeof change === 'function') {
        classification = classification.then(async () => enqueue(await change()))
      } else {
        enqueue(change)
      }
    },
    async run() {
      while (!session.signal.aborted) {
        const run = session.launch(invocation, serverArgs)
        requestRestart = run.restart
        const result = await run.completion
        requestRestart = undefined

        if (result.kind === 'error') throw result.error
        if (session.signal.aborted) return
        if (result.restartRequested) {
          await drain()
          continue
        }
        if (result.code === 0) return

        throw new Error(`Project development server failed with exit code ${result.code ?? 'unknown'}.`)
      }
    },
    async shutdown() {
      requestRestart = undefined
      session.dispose()
      await drain()
    },
  }
}
