import { resolve } from 'node:path'
import { loadHoloPluginContributionModules, type HoloPluginRuntimeModule } from '@holo-js/config'
import type { QueueDriverFactory } from './contracts'

const loadedFactoriesByProjectRoot = new Map<string, readonly QueueDriverFactory[]>()
const failedLoadsByProjectRoot = new Map<string, unknown>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveQueueDriverFactory(moduleValue: unknown, packageName: string, driverName: string): QueueDriverFactory {
  const candidate = isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
    ? moduleValue.default
    : isRecord(moduleValue) && typeof moduleValue.factory !== 'undefined'
      ? moduleValue.factory
      : moduleValue

  if (!isRecord(candidate) || candidate.driver !== driverName || typeof candidate.create !== 'function') {
    throw new Error(`[@holo-js/queue] Plugin ${packageName} queue driver "${driverName}" must export a matching QueueDriverFactory.`)
  }

  return candidate as unknown as QueueDriverFactory
}

export async function loadQueuePluginDriverFactories(projectRoot = process.cwd()): Promise<readonly QueueDriverFactory[]> {
  const root = resolve(projectRoot)
  const loadedFactories = loadedFactoriesByProjectRoot.get(root)
  if (loadedFactories) {
    return loadedFactories
  }

  if (failedLoadsByProjectRoot.has(root)) {
    throw failedLoadsByProjectRoot.get(root)
  }

  const contributions: readonly HoloPluginRuntimeModule[] = await loadHoloPluginContributionModules(root, 'queue', 'drivers')
  let factories: readonly QueueDriverFactory[]

  try {
    factories = Object.freeze(contributions.map(contribution => resolveQueueDriverFactory(
      contribution.module,
      contribution.plugin.packageName,
      contribution.name,
    )))
  } catch (error) {
    failedLoadsByProjectRoot.set(root, error)
    throw error
  }

  loadedFactoriesByProjectRoot.set(root, factories)
  return factories
}

export function resetQueuePluginDriverFactories(): void {
  loadedFactoriesByProjectRoot.clear()
  failedLoadsByProjectRoot.clear()
}
