import { loadHoloPluginContributionModules, type NormalizedCachePluginDriverConfig } from '@holo-js/config'
import type { CacheDriverContract } from './contracts'

const loadedContractsByProjectRoot = new Map<string, readonly CacheDriverContract[]>()
const failedLoadsByProjectRoot = new Map<string, unknown>()

type CachePluginDriverFactory = {
  readonly driver: string
  create(config: NormalizedCachePluginDriverConfig): CacheDriverContract
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolvePluginCandidate(moduleValue: unknown): unknown {
  return isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
    ? moduleValue.default
    : isRecord(moduleValue) && typeof moduleValue.driver !== 'undefined'
      ? moduleValue.driver
      : moduleValue
}

function isCachePluginDriverFactory(candidate: unknown, driverName: string): candidate is CachePluginDriverFactory {
  return isRecord(candidate)
    && candidate.driver === driverName
    && typeof candidate.create === 'function'
}

function assertCacheDriverContract(
  candidate: unknown,
  packageName: string,
  driverName: string,
  expectedName: string,
): asserts candidate is CacheDriverContract {
  if (
    !isRecord(candidate)
    || candidate.driver !== driverName
    || candidate.name !== expectedName
    || typeof candidate.get !== 'function'
    || typeof candidate.put !== 'function'
    || typeof candidate.add !== 'function'
    || typeof candidate.forget !== 'function'
    || typeof candidate.flush !== 'function'
    || typeof candidate.increment !== 'function'
    || typeof candidate.decrement !== 'function'
    || typeof candidate.lock !== 'function'
  ) {
    throw new Error(`[@holo-js/cache] Plugin ${packageName} cache driver "${driverName}" must export a matching CacheDriverContract.`)
  }
}

function resolveCacheDriver(moduleValue: unknown, packageName: string, driverName: string): CacheDriverContract {
  const candidate = resolvePluginCandidate(moduleValue)
  assertCacheDriverContract(candidate, packageName, driverName, driverName)
  return candidate as unknown as CacheDriverContract
}

function resolveConfiguredCacheDriver(
  moduleValue: unknown,
  packageName: string,
  driverName: string,
  config: NormalizedCachePluginDriverConfig,
): CacheDriverContract {
  const candidate = resolvePluginCandidate(moduleValue)
  if (isCachePluginDriverFactory(candidate, driverName)) {
    const driver = candidate.create(config)
    assertCacheDriverContract(driver, packageName, driverName, config.name)
    return driver
  }

  assertCacheDriverContract(candidate, packageName, driverName, driverName)
  return Object.freeze({
    ...candidate,
    name: config.name,
    driver: driverName,
  })
}

export async function loadCachePluginDriverContracts(projectRoot = process.cwd()): Promise<readonly CacheDriverContract[]> {
  const loadedContracts = loadedContractsByProjectRoot.get(projectRoot)
  if (loadedContracts) {
    return loadedContracts
  }

  if (failedLoadsByProjectRoot.has(projectRoot)) {
    throw failedLoadsByProjectRoot.get(projectRoot)
  }

  const contributions = await loadHoloPluginContributionModules(projectRoot, 'cache', 'drivers')
  let drivers: readonly CacheDriverContract[]

  try {
    drivers = Object.freeze(contributions.map(contribution => resolveCacheDriver(
      contribution.module,
      contribution.plugin.packageName,
      contribution.name,
    )))
  } catch (error) {
    failedLoadsByProjectRoot.set(projectRoot, error)
    throw error
  }

  loadedContractsByProjectRoot.set(projectRoot, drivers)
  return drivers
}

export async function loadConfiguredCachePluginDriverContracts(
  projectRoot: string,
  configs: readonly NormalizedCachePluginDriverConfig[],
): Promise<readonly CacheDriverContract[]> {
  if (configs.length === 0) {
    return Object.freeze([])
  }

  const contributions = await loadHoloPluginContributionModules(projectRoot, 'cache', 'drivers')
  const drivers: CacheDriverContract[] = []

  for (const contribution of contributions) {
    const matchingConfigs = configs.filter(config => config.driver === contribution.name)
    for (const config of matchingConfigs) {
      drivers.push(resolveConfiguredCacheDriver(
        contribution.module,
        contribution.plugin.packageName,
        contribution.name,
        config,
      ))
    }
  }

  return Object.freeze(drivers)
}

export function resetCachePluginDriverContracts(): void {
  loadedContractsByProjectRoot.clear()
  failedLoadsByProjectRoot.clear()
}
