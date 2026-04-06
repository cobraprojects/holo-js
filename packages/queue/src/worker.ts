import { randomUUID } from 'node:crypto'
import type {
  QueueAsyncDriver,
  QueueClearInput,
  QueueDriver,
  QueueJobDefinition,
  QueueJobEnvelope,
  QueueJsonValue,
  QueueReservedJob,
  QueueWorkerJobEvent,
  QueueWorkerOptions,
  QueueWorkerResult,
  QueueWorkerRunOptions,
} from './contracts'
import { DEFAULT_QUEUE_NAME } from './config'
import { persistFailedQueueJob } from './failed'
import { getRegisteredQueueJob } from './registry'
import { queueRuntimeInternals } from './runtime'

export class QueueWorkerUnsupportedDriverError extends Error {
  constructor(connectionName: string, driverName: string) {
    super(
      `[Holo Queue] Queue worker requires an async-capable driver, `
      + `but connection "${connectionName}" uses "${driverName}".`,
    )
  }
}

export class QueueWorkerTimeoutError extends Error {
  constructor(jobName: string, timeoutSeconds: number) {
    super(`[Holo Queue] Queue job "${jobName}" exceeded timeout of ${timeoutSeconds} seconds.`)
  }
}

type QueueWorkerProcessingOutcome =
  | { readonly kind: 'processed' }
  | { readonly kind: 'released', readonly delaySeconds?: number, readonly error?: Error }
  | { readonly kind: 'failed', readonly error: Error }

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function requireAsyncDriver(driver: QueueDriver, connectionName: string): QueueAsyncDriver {
  if (driver.mode !== 'async') {
    throw new QueueWorkerUnsupportedDriverError(connectionName, driver.driver)
  }

  return driver
}

function requireRegisteredDefinition(jobName: string): QueueJobDefinition {
  const registered = getRegisteredQueueJob(jobName)
  if (!registered) {
    throw new Error(`[Holo Queue] Queue job "${jobName}" is not registered.`)
  }

  return registered.definition
}

function normalizeQueueNames(
  queueNames: readonly string[] | undefined,
  fallbackQueueName: string | undefined,
): readonly string[] {
  if (!queueNames || queueNames.length === 0) {
    return Object.freeze([fallbackQueueName ?? DEFAULT_QUEUE_NAME])
  }

  const normalized = [...new Set(queueNames.map(name => name.trim()).filter(Boolean))]
  if (normalized.length === 0) {
    throw new Error('[Holo Queue] Queue worker queue names must be non-empty strings.')
  }

  return Object.freeze(normalized)
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[Holo Queue] ${label} must be a non-negative integer.`)
  }

  return value
}

function normalizePositiveInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[Holo Queue] ${label} must be a positive integer.`)
  }

  return value
}

function createWorkerEvent(
  envelope: QueueJobEnvelope,
  maxAttempts: number,
): QueueWorkerJobEvent {
  return {
    jobId: envelope.id,
    jobName: envelope.name,
    connection: envelope.connection,
    queue: envelope.queue,
    attempt: envelope.attempts + 1,
    maxAttempts,
  }
}

function resolveRetryDelaySeconds(
  definition: QueueJobDefinition,
  attempt: number,
): number | undefined {
  const { backoff } = definition
  if (typeof backoff === 'undefined') {
    return undefined
  }

  if (typeof backoff === 'number') {
    return backoff
  }

  return backoff[Math.min(Math.max(attempt - 1, 0), backoff.length - 1)]
}

async function runWithTimeout<TResult>(
  callback: Promise<TResult>,
  jobName: string,
  timeoutSeconds: number | undefined,
  onTimeout?: () => void,
): Promise<TResult> {
  if (typeof timeoutSeconds === 'undefined') {
    return await callback
  }

  return await Promise.race([
    callback,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.()
        reject(new QueueWorkerTimeoutError(jobName, timeoutSeconds))
      }, timeoutSeconds * 1000)

      callback.finally(() => {
        clearTimeout(timer)
      }).catch(() => {})
    }),
  ])
}

async function processReservedJob(
  driver: QueueAsyncDriver,
  reserved: QueueReservedJob<QueueJsonValue>,
  options: Pick<QueueWorkerRunOptions, 'timeout' | 'tries' | 'onJobFailed' | 'onJobProcessed' | 'onJobReleased'>,
): Promise<QueueWorkerProcessingOutcome> {
  const envelope = reserved.envelope
  const definition = requireRegisteredDefinition(envelope.name)
  const maxAttempts = options.tries ?? envelope.maxAttempts
  const event = createWorkerEvent(envelope, maxAttempts)
  const executionState = {
    timedOut: false,
  }
  let requestedReleaseDelay: number | undefined
  let requestedFailure: Error | undefined
  let action: 'release' | 'fail' | undefined

  try {
    await runWithTimeout(
      queueRuntimeInternals.executeRegisteredQueueJob(envelope, {
        maxAttempts,
        shouldSkipLifecycleHooks() {
          return executionState.timedOut || typeof action !== 'undefined'
        },
        async release(delaySeconds?: number) {
          if (!action) {
            action = 'release'
            requestedReleaseDelay = delaySeconds
          }
        },
        async fail(error: Error) {
          if (!action) {
            action = 'fail'
            requestedFailure = error
          }

          throw error
        },
      }),
      envelope.name,
      options.timeout ?? definition.timeout,
      () => {
        executionState.timedOut = true
      },
    )

    if (action === 'release') {
      await driver.release(reserved, typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : undefined)
      await options.onJobReleased?.({
        ...event,
        ...(typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : {}),
      })
      return {
        kind: 'released',
        ...(typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : {}),
      }
    }

    if (action === 'fail') {
      const failure = requestedFailure!
      await persistFailedQueueJob(reserved, failure)
      await driver.delete(reserved)
      await queueRuntimeInternals.executeRegisteredQueueJobFailedHook(envelope, failure, {
        maxAttempts,
      })
      await options.onJobFailed?.({
        ...event,
        error: failure,
      })
      return {
        kind: 'failed',
        error: failure,
      }
    }

    await driver.acknowledge(reserved)
    await options.onJobProcessed?.(event)
    return { kind: 'processed' }
  } catch (error) {
    const resolvedError = error instanceof Error ? error : new Error(String(error))
    const failure = resolvedError instanceof QueueWorkerTimeoutError
      ? resolvedError
      : requestedFailure ?? resolvedError

    if (resolvedError instanceof QueueWorkerTimeoutError) {
      await persistFailedQueueJob(reserved, failure)
      await driver.delete(reserved)
      await queueRuntimeInternals.executeRegisteredQueueJobFailedHook(envelope, failure, {
        maxAttempts,
      })
      await options.onJobFailed?.({
        ...event,
        error: failure,
      })
      return {
        kind: 'failed',
        error: failure,
      }
    }

    if (action === 'release') {
      await driver.release(reserved, typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : undefined)
      await options.onJobReleased?.({
        ...event,
        ...(typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : {}),
        error: failure,
      })
      return {
        kind: 'released',
        ...(typeof requestedReleaseDelay === 'number' ? { delaySeconds: requestedReleaseDelay } : {}),
        error: failure,
      }
    }

    if (action === 'fail' || event.attempt >= maxAttempts) {
      await persistFailedQueueJob(reserved, failure)
      await driver.delete(reserved)
      await queueRuntimeInternals.executeRegisteredQueueJobFailedHook(envelope, failure, {
        maxAttempts,
      })
      await options.onJobFailed?.({
        ...event,
        error: failure,
      })
      return {
        kind: 'failed',
        error: failure,
      }
    }

    const delaySeconds = resolveRetryDelaySeconds(definition, event.attempt)
    await driver.release(reserved, typeof delaySeconds === 'number' ? { delaySeconds } : undefined)
    await options.onJobReleased?.({
      ...event,
      ...(typeof delaySeconds === 'number' ? { delaySeconds } : {}),
      error: failure,
    })
    return {
      kind: 'released',
      ...(typeof delaySeconds === 'number' ? { delaySeconds } : {}),
      error: failure,
    }
  }
}

function resolveWorkerStopReason(
  options: QueueWorkerOptions,
  state: {
    readonly processed: number
    readonly startedAt: number
  },
): QueueWorkerResult['stoppedBecause'] | undefined {
  const now = Date.now()

  if (typeof options.maxJobs === 'number' && state.processed >= options.maxJobs) {
    return 'max-jobs'
  }

  if (typeof options.maxTime === 'number' && now - state.startedAt >= options.maxTime * 1000) {
    return 'max-time'
  }

  return undefined
}

export async function runQueueWorker(options: QueueWorkerRunOptions = {}): Promise<QueueWorkerResult> {
  const connectionName = options.connection ?? queueRuntimeInternals.getQueueRuntimeState().config.default
  const connection = queueRuntimeInternals.resolveConnectionConfig(
    queueRuntimeInternals.getQueueRuntimeState().config,
    connectionName,
  )
  const queueNames = normalizeQueueNames(options.queueNames, connection.queue)
  const sleepSeconds = normalizeNonNegativeInteger(options.sleep, 'Queue worker sleep')
    ?? ('sleep' in connection && typeof connection.sleep === 'number' ? connection.sleep : 1)
  const maxJobs = normalizePositiveInteger(options.maxJobs, 'Queue worker maxJobs')
  const maxTime = normalizePositiveInteger(options.maxTime, 'Queue worker maxTime')
  const workerId = options.workerId?.trim() || randomUUID()
  const sleepFn = options.sleepFn ?? sleep
  const driver = requireAsyncDriver(queueRuntimeInternals.resolveConnectionDriver(connection.name), connection.name)
  const startedAt = Date.now()
  let processed = 0
  let released = 0
  let failed = 0

  const normalizedOptions: QueueWorkerOptions = {
    ...options,
    connection: connection.name,
    maxJobs,
    maxTime,
  }

  while (true) {
    if (await options.shouldStop?.()) {
      return {
        processed,
        released,
        failed,
        stoppedBecause: 'signal',
      }
    }

    const stopReason = resolveWorkerStopReason(normalizedOptions, {
      processed: processed + released + failed,
      startedAt,
    })
    if (stopReason) {
      return {
        processed,
        released,
        failed,
        stoppedBecause: stopReason,
      }
    }

    const reserved = await driver.reserve({
      queueNames,
      workerId,
    })

    if (!reserved) {
      await options.onIdle?.()

      if (options.once === true) {
        return {
          processed,
          released,
          failed,
          stoppedBecause: 'once',
        }
      }

      if (options.stopWhenEmpty === true) {
        return {
          processed,
          released,
          failed,
          stoppedBecause: 'empty',
        }
      }

      if (sleepSeconds > 0) {
        await sleepFn(sleepSeconds * 1000)
      }

      continue
    }

    const outcome = await processReservedJob(driver, reserved as QueueReservedJob<QueueJsonValue>, options)
    if (outcome.kind === 'processed') {
      processed += 1
    } else if (outcome.kind === 'released') {
      released += 1
    } else {
      failed += 1
    }

    if (options.once === true) {
      return {
        processed,
        released,
        failed,
        stoppedBecause: 'once',
      }
    }
  }
}

export async function clearQueueConnection(
  connectionName?: string,
  input: QueueClearInput = {},
): Promise<number> {
  const connection = queueRuntimeInternals.resolveConnectionConfig(
    queueRuntimeInternals.getQueueRuntimeState().config,
    connectionName,
  )
  const driver = queueRuntimeInternals.resolveConnectionDriver(connection.name)
  return await driver.clear(input)
}

export const queueWorkerInternals = {
  createWorkerEvent,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeQueueNames,
  processReservedJob,
  requireAsyncDriver,
  requireRegisteredDefinition,
  resolveRetryDelaySeconds,
  resolveWorkerStopReason,
  runWithTimeout,
  sleep,
}
