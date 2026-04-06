import type {
  QueueJsonValue,
  QueueRegisteredJob,
  RegisterableQueueJobDefinition,
  RegisterQueueJobOptions,
} from './contracts'
import {
  isQueueJobDefinition,
  normalizeQueueJobDefinition,
} from './contracts'

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function deriveJobNameFromSourcePath(sourcePath: string): string {
  const normalized = toPosixPath(sourcePath).replace(/\.[^.]+$/, '')
  const jobRootIndex = normalized.lastIndexOf('/jobs/')
  const relevant = jobRootIndex >= 0
    ? normalized.slice(jobRootIndex + '/jobs/'.length)
    : normalized

  return relevant
    .split('/')
    .filter(Boolean)
    .join('.')
}

function getQueueRegistryState(): {
  jobs: Map<string, QueueRegisteredJob>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueRegistry__?: {
      jobs: Map<string, QueueRegisteredJob>
    }
  }

  runtime.__holoQueueRegistry__ ??= {
    jobs: new Map<string, QueueRegisteredJob>(),
  }

  return runtime.__holoQueueRegistry__
}

function resolveRegistrationName(
  definition: RegisterableQueueJobDefinition,
  options: RegisterQueueJobOptions = {},
): string {
  const explicit = options.name?.trim()
  if (explicit) {
    return explicit
  }

  const fromSource = options.sourcePath?.trim()
  if (fromSource) {
    return deriveJobNameFromSourcePath(fromSource)
  }

  throw new Error('[Holo Queue] Registered jobs require an explicit name or a sourcePath-derived name.')
}

export function registerQueueJob<TPayload extends QueueJsonValue, TResult>(
  definition: RegisterableQueueJobDefinition<TPayload, TResult>,
  options: RegisterQueueJobOptions = {},
): QueueRegisteredJob<TPayload, TResult> {
  if (!isQueueJobDefinition(definition)) {
    throw new Error('[Holo Queue] Jobs must define a "handle" function.')
  }

  const normalizedDefinition = normalizeQueueJobDefinition(definition)
  const name = resolveRegistrationName(normalizedDefinition, options)
  const registry = getQueueRegistryState().jobs

  if (registry.has(name) && options.replaceExisting !== true) {
    throw new Error(`[Holo Queue] Queue job "${name}" is already registered.`)
  }

  const entry = Object.freeze({
    name,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    definition: Object.freeze({
      ...normalizedDefinition,
    }),
  }) as QueueRegisteredJob<TPayload, TResult>

  registry.set(name, entry as unknown as QueueRegisteredJob)
  return entry
}

export function registerQueueJobs(
  definitions: ReadonlyArray<{
    readonly definition: RegisterableQueueJobDefinition
    readonly options?: RegisterQueueJobOptions
  }>,
): ReadonlyArray<QueueRegisteredJob> {
  return Object.freeze(definitions.map(entry => registerQueueJob(entry.definition, entry.options)))
}

export function getRegisteredQueueJob(name: string): QueueRegisteredJob | undefined {
  return getQueueRegistryState().jobs.get(name)
}

export function listRegisteredQueueJobs(): readonly QueueRegisteredJob[] {
  return Object.freeze([...getQueueRegistryState().jobs.values()].sort((left, right) => left.name.localeCompare(right.name)))
}

export function unregisterQueueJob(name: string): boolean {
  return getQueueRegistryState().jobs.delete(name)
}

export function resetQueueRegistry(): void {
  getQueueRegistryState().jobs.clear()
}

export const queueRegistryInternals = {
  deriveJobNameFromSourcePath,
}
