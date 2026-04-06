import {
  dispatch,
  defineJob,
  getRegisteredQueueJob,
  registerQueueJob,
  type QueueJobDefinition,
  type QueueJsonValue,
} from '@holo-js/queue'
import { connectionAsyncContext } from '@holo-js/db'
import { regenerateMediaEntityConversions } from './model/conversions'
import { Media } from './model/Media'

export const MEDIA_GENERATE_CONVERSIONS_JOB = 'media.generate-conversions'

export type MediaGenerateConversionsPayload = Readonly<Record<string, QueueJsonValue>> & Readonly<{
  readonly mediaId: string | number
  readonly conversionNames: readonly string[]
}>

export interface MediaGenerateConversionsResult {
  readonly status: 'missing-media' | 'processed'
  readonly conversionNames: readonly string[]
}

declare module '@holo-js/queue' {
  interface HoloQueueJobRegistry {
    'media.generate-conversions': QueueJobDefinition<
      MediaGenerateConversionsPayload,
      MediaGenerateConversionsResult
    >
  }
}

function normalizeConversionNames(
  conversionNames?: readonly string[],
): readonly string[] | undefined {
  if (!conversionNames || conversionNames.length === 0) {
    return undefined
  }

  const normalized = [...new Set(
    conversionNames
      .map(name => name.trim())
      .filter(Boolean),
  )]

  return normalized.length > 0
    ? Object.freeze(normalized)
    : undefined
}

function normalizeMediaIdentifier(
  mediaId: string | number,
): string | number {
  if (typeof mediaId === 'number') {
    if (!Number.isFinite(mediaId)) {
      throw new Error('[Holo Media] Queued media conversion jobs require a finite media identifier.')
    }

    return mediaId
  }

  const normalized = mediaId.trim()
  if (!normalized) {
    throw new Error('[Holo Media] Queued media conversion jobs require a non-empty media identifier.')
  }

  return normalized
}

function normalizePayload(
  payload: MediaGenerateConversionsPayload,
): MediaGenerateConversionsPayload {
  return Object.freeze({
    mediaId: normalizeMediaIdentifier(payload.mediaId),
    conversionNames: normalizeConversionNames(payload.conversionNames) ?? Object.freeze([]),
  })
}

export async function runMediaGenerateConversionsJob(
  payload: MediaGenerateConversionsPayload,
): Promise<MediaGenerateConversionsResult> {
  const normalized = normalizePayload(payload)
  const media = await Media.find(normalized.mediaId)

  if (!media) {
    return Object.freeze({
      status: 'missing-media',
      conversionNames: Object.freeze([]),
    })
  }

  await regenerateMediaEntityConversions({
    media,
    conversions: normalized.conversionNames,
    includeQueued: true,
  })

  return Object.freeze({
    status: 'processed',
    conversionNames: normalized.conversionNames,
  })
}

export function ensureMediaQueueJobRegistered(): void {
  if (getRegisteredQueueJob(MEDIA_GENERATE_CONVERSIONS_JOB)) {
    return
  }

  registerQueueJob(defineJob({
    queue: 'media',
    async handle(payload: MediaGenerateConversionsPayload) {
      return runMediaGenerateConversionsJob(payload)
    },
  }), {
    name: MEDIA_GENERATE_CONVERSIONS_JOB,
  })
}

function getActiveTransaction() {
  const active = connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return undefined
  }

  return active
}

async function executeQueuedMediaDispatch(
  payload: MediaGenerateConversionsPayload,
  onSynchronousDispatch?: () => Promise<void>,
): Promise<void> {
  const dispatched = await dispatch(MEDIA_GENERATE_CONVERSIONS_JOB, payload)
  if (dispatched.synchronous) {
    await onSynchronousDispatch?.()
  }
}

export async function dispatchQueuedMediaConversions(
  payload: MediaGenerateConversionsPayload,
): Promise<void> {
  const normalized = normalizePayload(payload)
  if (normalized.conversionNames.length === 0) {
    return
  }

  ensureMediaQueueJobRegistered()

  const activeTransaction = getActiveTransaction()
  if (activeTransaction) {
    activeTransaction.afterCommit(() => executeQueuedMediaDispatch(normalized))
    return
  }

  await executeQueuedMediaDispatch(normalized)
}

export async function dispatchQueuedMediaConversionsForModel(
  payload: MediaGenerateConversionsPayload,
  onSynchronousDispatch?: () => Promise<void>,
): Promise<void> {
  const normalized = normalizePayload(payload)
  if (normalized.conversionNames.length === 0) {
    return
  }

  ensureMediaQueueJobRegistered()

  const activeTransaction = getActiveTransaction()
  if (activeTransaction) {
    activeTransaction.afterCommit(() => executeQueuedMediaDispatch(normalized, onSynchronousDispatch))
    return
  }

  await executeQueuedMediaDispatch(normalized, onSynchronousDispatch)
}
