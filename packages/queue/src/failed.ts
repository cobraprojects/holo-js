import type {
  QueueFailedJobRecord,
  QueueReservedJob,
} from './contracts'
import { queueRuntimeInternals } from './runtime'

function normalizeFailedStoreErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export class QueueFailedStoreError extends Error {
  constructor(action: string, cause: unknown) {
    super(
      `[Holo Queue] Failed job store could not ${action}: ${normalizeFailedStoreErrorMessage(cause)}`,
      { cause },
    )
    this.name = 'QueueFailedStoreError'
  }
}

function wrapFailedStoreError(action: string, error: unknown): QueueFailedStoreError {
  if (error instanceof QueueFailedStoreError) {
    return error
  }

  return new QueueFailedStoreError(action, error)
}

function getFailedJobStore() {
  return queueRuntimeInternals.getQueueRuntimeState().failedJobStore
}

function createRetriedEnvelope(record: QueueFailedJobRecord) {
  return Object.freeze({
    ...record.job,
    attempts: 0,
    createdAt: Date.now(),
    availableAt: undefined,
  })
}

export async function persistFailedQueueJob(
  reserved: QueueReservedJob,
  error: Error,
): Promise<QueueFailedJobRecord | null> {
  const store = getFailedJobStore()
  if (!store) {
    return null
  }

  try {
    return await store.persistFailedJob(reserved, error)
  } catch (cause) {
    throw wrapFailedStoreError('persist the failed job', cause)
  }
}

export async function listFailedQueueJobs(): Promise<readonly QueueFailedJobRecord[]> {
  const store = getFailedJobStore()
  if (!store) {
    return Object.freeze([])
  }

  try {
    return await store.listFailedJobs()
  } catch (cause) {
    throw wrapFailedStoreError('list failed jobs', cause)
  }
}

export async function retryFailedQueueJobs(identifier: 'all' | string): Promise<number> {
  const store = getFailedJobStore()
  if (!store) {
    return 0
  }

  try {
    return await store.retryFailedJobs(identifier, async (record) => {
      const driver = queueRuntimeInternals.resolveConnectionDriver(record.job.connection)
      await driver.dispatch(createRetriedEnvelope(record))
    })
  } catch (cause) {
    throw wrapFailedStoreError('retry failed jobs', cause)
  }
}

export async function forgetFailedQueueJob(id: string): Promise<boolean> {
  const store = getFailedJobStore()
  if (!store) {
    return false
  }

  try {
    return await store.forgetFailedJob(id)
  } catch (cause) {
    throw wrapFailedStoreError('forget the failed job', cause)
  }
}

export async function flushFailedQueueJobs(): Promise<number> {
  const store = getFailedJobStore()
  if (!store) {
    return 0
  }

  try {
    return await store.flushFailedJobs()
  } catch (cause) {
    throw wrapFailedStoreError('flush failed jobs', cause)
  }
}

export const queueFailedInternals = {
  createRetriedEnvelope,
  getFailedJobStore,
  normalizeFailedStoreErrorMessage,
  wrapFailedStoreError,
}
