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
  const loadedFactories = loadedFactoriesByProjectRoot.get(projectRoot)
  if (loadedFactories) {
    return loadedFactories
  }

  if (failedLoadsByProjectRoot.has(projectRoot)) {
    throw failedLoadsByProjectRoot.get(projectRoot)
  }

  const contributions: readonly HoloPluginRuntimeModule[] = await loadHoloPluginContributionModules(projectRoot, 'queue', 'drivers')
  let factories: readonly QueueDriverFactory[]

  try {
    factories = Object.freeze(contributions.map(contribution => resolveQueueDriverFactory(
      contribution.module,
      contribution.plugin.packageName,
      contribution.name,
    )))
  } catch (error) {
    failedLoadsByProjectRoot.set(projectRoot, error)
    throw error
  }

  loadedFactoriesByProjectRoot.set(projectRoot, factories)
  return factories
}

export function resetQueuePluginDriverFactories(): void {
  loadedFactoriesByProjectRoot.clear()
  failedLoadsByProjectRoot.clear()
}
