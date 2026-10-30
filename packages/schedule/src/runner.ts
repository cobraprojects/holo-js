import { createHash } from 'node:crypto'
import { cronMatches, formatHourMinute, nextCronDate, parseCronExpression } from './cron'
import type { ScheduleDefinition } from './schedule'
import { SCHEDULED_TASK_STATE, type ScheduledTask, type ScheduledTaskState } from './task'

const ONE_SERVER_LOCK_SECONDS = 3600

export type ScheduledTaskOutcome = 'ran' | 'failed' | 'skipped-overlapping' | 'skipped-other-server'

export interface ScheduledTaskReport {
  readonly summary: string
  readonly outcome: ScheduledTaskOutcome
  readonly error?: Error
}

export interface ScheduleRunOptions {
  readonly now: Date
  readonly timezone: string
  readonly signal?: AbortSignal
  runCommand(argv: readonly string[]): Promise<number>
  onTaskFinished?(report: ScheduledTaskReport): void
}

export interface ScheduledTaskListing {
  readonly expression: string
  readonly summary: string
  readonly timezone: string
  readonly nextDueAt: Date
}

type ScheduleLock = {
  get(): Promise<unknown>
  release(): Promise<boolean>
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function stateOf(task: ScheduledTask): ScheduledTaskState {
  return task[SCHEDULED_TASK_STATE]
}

async function resolveJobName(job: object): Promise<string> {
  const { queueJobInternals } = await import('@holo-js/queue')
  return queueJobInternals.resolveQueueJobDefinitionName(job)
}

async function describeTask(state: ScheduledTaskState): Promise<string> {
  if (state.description) return state.description
  switch (state.action.kind) {
    case 'command': return `holo ${state.action.command}`
    case 'job': return await resolveJobName(state.action.job)
    case 'call': return 'Closure'
  }
}

async function mutexName(state: ScheduledTaskState): Promise<string> {
  switch (state.action.kind) {
    case 'command': return `framework/schedule-${sha1(state.expression + state.action.command)}`
    case 'job': return `framework/schedule-${sha1(state.description ?? await resolveJobName(state.action.job))}`
    case 'call': return `framework/schedule-${sha1(state.description ?? state.expression + state.action.callback.toString())}`
  }
}

async function cacheLock(name: string, seconds: number): Promise<ScheduleLock> {
  const { cacheFacade } = await import('@holo-js/cache')
  return cacheFacade.lock(name, seconds)
}

async function execute(state: ScheduledTaskState, summary: string, options: ScheduleRunOptions): Promise<void> {
  switch (state.action.kind) {
    case 'command': {
      const exitCode = await options.runCommand(state.action.argv)
      if (exitCode !== 0) throw new Error(`Scheduled command [${summary}] failed with exit code [${exitCode}].`)
      return
    }
    case 'job':
      await state.action.dispatch()
      return
    case 'call':
      if (await state.action.callback() === false) {
        throw new Error(`Scheduled task [${summary}] failed with exit code [1].`)
      }
  }
}

async function runTask(state: ScheduledTaskState, options: ScheduleRunOptions): Promise<ScheduledTaskReport | undefined> {
  const summary = await describeTask(state)
  const name = await mutexName(state)

  if (state.onOneServer) {
    const serverLock = await cacheLock(`${name}${formatHourMinute(options.now, options.timezone)}`, ONE_SERVER_LOCK_SECONDS)
    if (await serverLock.get() !== true) return { summary, outcome: 'skipped-other-server' }
  }

  const overlapLock = state.withoutOverlapping ? await cacheLock(name, state.expiresAtMinutes * 60) : undefined
  if (overlapLock && await overlapLock.get() !== true) return { summary, outcome: 'skipped-overlapping' }

  try {
    if (options.signal?.aborted) return undefined
    await execute(state, summary, options)
    return { summary, outcome: 'ran' }
  } finally {
    await overlapLock?.release()
  }
}

function isDue(state: ScheduledTaskState, now: Date, timezone: string): boolean {
  return cronMatches(parseCronExpression(state.expression), now, state.timezone ?? timezone)
}

export async function runDueScheduledTasks(
  definition: ScheduleDefinition,
  options: ScheduleRunOptions,
): Promise<readonly ScheduledTaskReport[]> {
  const due = definition.tasks.map(stateOf).filter(state => isDue(state, options.now, options.timezone))
  const reports: ScheduledTaskReport[] = []
  for (const state of due) {
    if (options.signal?.aborted) break
    const report = await runTask(state, options).catch(async (error: unknown): Promise<ScheduledTaskReport | undefined> => ({
      summary: await describeTask(state).catch(() => state.action.kind),
      outcome: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    }))
    if (!report) break
    reports.push(report)
    options.onTaskFinished?.(report)
  }
  return reports
}

export async function listScheduledTasks(
  definition: ScheduleDefinition,
  options: { readonly now: Date, readonly timezone: string },
): Promise<readonly ScheduledTaskListing[]> {
  return await Promise.all(definition.tasks.map(stateOf).map(async (state) => {
    const timezone = state.timezone ?? options.timezone
    return {
      expression: state.expression,
      summary: await describeTask(state),
      timezone,
      nextDueAt: nextCronDate(parseCronExpression(state.expression), options.now, timezone, state.expression),
    }
  }))
}
