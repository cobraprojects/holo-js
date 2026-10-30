import { spawn } from 'node:child_process'
import { relative, resolve } from 'node:path'
import type * as ScheduleModule from '@holo-js/schedule'
import type { ScheduleDefinition, ScheduledTaskReport } from '@holo-js/schedule'
import { reportError } from '@holo-js/kernel/error-reporting'
import { writeLine } from './io'
import {
  loadProjectConfig,
  prepareProjectDiscovery,
  resolveProjectPackageImportSpecifier,
} from './project'
import { resolveFirstExistingPath } from './project/runtime'
import { resolveModuleExport, resolveRunnableCliEntrypoint } from './queue'
import { initializeProjectRuntime } from './runtime'
import type { FrameworkSpawn } from './framework-run'
import type { IoStreams, SpawnProcessLike } from './cli-types'

export const SCHEDULE_FILE_NAMES = [
  'server/schedule.ts',
  'server/schedule.mts',
  'server/schedule.js',
  'server/schedule.mjs',
] as const

const MINUTE_MS = 60_000
const NO_DUE_TASKS_MESSAGE = '[schedule] No scheduled commands are ready to run.'
const NO_TASKS_MESSAGE = '[schedule] No scheduled tasks have been defined.'

type ScheduleCliModule = Pick<typeof ScheduleModule, 'isScheduleDefinition' | 'listScheduledTasks' | 'runDueScheduledTasks'>

export type ScheduleEnvironment = {
  readonly schedule: ScheduleDefinition
  readonly scheduleModule: ScheduleCliModule
  readonly timezone: string
  cleanup(): Promise<void>
}

export type ScheduleEnvironmentLoader = (projectRoot: string) => Promise<ScheduleEnvironment | undefined>

async function loadScheduleCliModule(projectRoot: string): Promise<ScheduleCliModule> {
  try {
    return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/schedule')) as ScheduleCliModule
  } catch (error) {
    throw new Error('[Holo CLI] Task scheduling requires @holo-js/schedule to be installed.', { cause: error })
  }
}

export async function loadScheduleEnvironment(projectRoot: string): Promise<ScheduleEnvironment | undefined> {
  const schedulePath = await resolveFirstExistingPath(projectRoot, SCHEDULE_FILE_NAMES)
  if (!schedulePath) return undefined

  const scheduleModule = await loadScheduleCliModule(projectRoot)
  const project = await loadProjectConfig(projectRoot, { required: true })
  const registry = await prepareProjectDiscovery(projectRoot, project.config)
  const definitionPaths = [...registry.jobs, ...registry.events, ...registry.listeners]
    .map(entry => resolve(projectRoot, entry.sourcePath))
  const { holoRuntimeInternals } = await import('@holo-js/core')
  const importDefinition = await holoRuntimeInternals.loadProjectDefinitionRuntimeModules(projectRoot, [...definitionPaths, schedulePath])
  holoRuntimeInternals.setProjectDefinitionImporter(projectRoot, importDefinition)
  const runtime = await initializeProjectRuntime(projectRoot)

  try {
    const schedule = resolveModuleExport(await importDefinition(schedulePath), scheduleModule.isScheduleDefinition)
    if (!schedule) {
      throw new Error(`[Holo CLI] ${relative(projectRoot, schedulePath)} must export a schedule created with defineSchedule().`)
    }

    return {
      schedule,
      scheduleModule,
      timezone: runtime.loadedConfig.app.timezone,
      cleanup: () => runtime.shutdown(),
    }
  } catch (error) {
    await runtime.shutdown().catch(() => {})
    throw error
  }
}

type ChildSupervisor = {
  readonly stopping: AbortSignal
  track(child: SpawnProcessLike): Promise<number | null>
  settled(): Promise<void>
  dispose(): void
}

function superviseChildren(io: IoStreams): ChildSupervisor {
  const stopping = new AbortController()
  const running = new Map<SpawnProcessLike, Promise<unknown>>()
  let stopSignal: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    stopSignal ??= signal
    for (const child of running.keys()) child.kill?.(signal)
    stopping.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  return {
    stopping: stopping.signal,
    track(child) {
      const exit = new Promise<number | null>((resolvePromise, rejectPromise) => {
        child.on('close', (code) => {
          running.delete(child)
          resolvePromise(code)
        })
        child.on('error', (error) => {
          if (child.pid === undefined) {
            running.delete(child)
            rejectPromise(error)
            return
          }
          writeLine(io.stderr, `[schedule] ${error.message}`)
        })
      })
      running.set(child, exit.catch(() => undefined))
      if (stopSignal) child.kill?.(stopSignal)
      return exit
    },
    async settled() {
      await Promise.all(running.values())
    },
    dispose() {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    },
  }
}

function writeTaskReport(io: IoStreams, report: ScheduledTaskReport): void {
  switch (report.outcome) {
    case 'ran':
      writeLine(io.stdout, `[schedule] Running [${report.summary}] DONE`)
      return
    case 'failed':
      writeLine(io.stdout, `[schedule] Running [${report.summary}] FAIL`)
      writeLine(io.stderr, report.error?.message ?? 'Scheduled task failed.')
      reportError(report.error, { capability: 'schedule', operation: 'task' })
      return
    case 'skipped-overlapping':
      writeLine(io.stdout, `[schedule] Skipping [${report.summary}] because its previous run is still in progress.`)
      return
    case 'skipped-other-server':
      writeLine(io.stdout, `[schedule] Skipping [${report.summary}] because the command already ran on another server.`)
  }
}

export async function runScheduleRunCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    readonly now?: () => Date
    readonly loadEnvironment?: ScheduleEnvironmentLoader
    readonly spawnProcess?: FrameworkSpawn
    readonly resolveCliEntrypoint?: typeof resolveRunnableCliEntrypoint
  } = {},
): Promise<void> {
  const startedAt = (dependencies.now ?? (() => new Date()))()
  const environment = await (dependencies.loadEnvironment ?? loadScheduleEnvironment)(projectRoot)
  if (!environment) {
    writeLine(io.stdout, NO_DUE_TASKS_MESSAGE)
    return
  }

  try {
    const cliEntrypoint = await (dependencies.resolveCliEntrypoint ?? resolveRunnableCliEntrypoint)()
    const supervisor = superviseChildren(io)
    try {
      const spawnProcess = dependencies.spawnProcess ?? spawn
      const reports = await environment.scheduleModule.runDueScheduledTasks(environment.schedule, {
        now: startedAt,
        timezone: environment.timezone,
        signal: supervisor.stopping,
        runCommand: async (argv) => {
          const child = spawnProcess(process.execPath, [cliEntrypoint.path, ...argv], {
            cwd: projectRoot,
            env: process.env,
            stdio: 'ignore',
          })
          return await supervisor.track(child) ?? 1
        },
        onTaskFinished: report => writeTaskReport(io, report),
      })
      if (reports.length === 0) writeLine(io.stdout, NO_DUE_TASKS_MESSAGE)
    } finally {
      supervisor.dispose()
      await cliEntrypoint.cleanup()
    }
  } finally {
    await environment.cleanup()
  }
}

function formatDueDate(date: Date, timezone: string): string {
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)
  return `${formatted} ${timezone}`
}

export async function runScheduleListCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    readonly now?: () => Date
    readonly loadEnvironment?: ScheduleEnvironmentLoader
  } = {},
): Promise<void> {
  const environment = await (dependencies.loadEnvironment ?? loadScheduleEnvironment)(projectRoot)
  if (!environment) {
    writeLine(io.stdout, NO_TASKS_MESSAGE)
    return
  }

  try {
    const tasks = await environment.scheduleModule.listScheduledTasks(environment.schedule, {
      now: (dependencies.now ?? (() => new Date()))(),
      timezone: environment.timezone,
    })
    if (tasks.length === 0) {
      writeLine(io.stdout, NO_TASKS_MESSAGE)
      return
    }

    const expressionWidth = Math.max(...tasks.map(task => task.expression.length))
    const summaryWidth = Math.max(...tasks.map(task => task.summary.length))
    for (const task of tasks) {
      writeLine(
        io.stdout,
        `${task.expression.padEnd(expressionWidth)}  ${task.summary.padEnd(summaryWidth)}  Next Due: ${formatDueDate(task.nextDueAt, environment.timezone)}`,
      )
    }
  } finally {
    await environment.cleanup()
  }
}

function waitForNextMinute(signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, MINUTE_MS - (Date.now() % MINUTE_MS))
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolvePromise()
    }
  })
}

export async function runScheduleWorkCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    readonly spawnProcess?: FrameworkSpawn
    readonly waitForNextMinute?: (signal: AbortSignal) => Promise<void>
    readonly resolveCliEntrypoint?: typeof resolveRunnableCliEntrypoint
  } = {},
): Promise<void> {
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const wait = dependencies.waitForNextMinute ?? waitForNextMinute
  const cliEntrypoint = await (dependencies.resolveCliEntrypoint ?? resolveRunnableCliEntrypoint)()
  const supervisor = superviseChildren(io)
  try {
    writeLine(io.stdout, '[schedule] Running scheduled tasks every minute.')
    while (!supervisor.stopping.aborted) {
      await wait(supervisor.stopping)
      if (supervisor.stopping.aborted) break

      const child = spawnProcess(process.execPath, [cliEntrypoint.path, 'schedule:run'], {
        cwd: projectRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.pipe(io.stdout, { end: false })
      child.stderr?.pipe(io.stderr, { end: false })
      supervisor.track(child).catch((error: Error) => {
        writeLine(io.stderr, `[schedule] Failed to start schedule:run: ${error.message}`)
      })
    }

    await supervisor.settled()
  } finally {
    supervisor.dispose()
    await cliEntrypoint.cleanup()
  }
}
