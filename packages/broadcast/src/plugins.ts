import { loadHoloPluginContributionModules } from '@holo-js/config'
import { getRegisteredBroadcastDriver, registerBroadcastDriver, unregisterBroadcastDriver } from './registry'
import type { BroadcastDriver } from './contracts'

const loadedProjectRoots = new Set<string>()
const registeredPluginDrivers = new Map<string, {
  readonly driver: BroadcastDriver
  readonly previous: BroadcastDriver | undefined
}>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveBroadcastDriver(moduleValue: unknown, packageName: string, driverName: string): BroadcastDriver {
  const candidate = isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
    ? moduleValue.default
    : isRecord(moduleValue) && typeof moduleValue.driver !== 'undefined'
      ? moduleValue.driver
      : moduleValue

  if (!isRecord(candidate) || typeof candidate.send !== 'function') {
    throw new Error(`[@holo-js/broadcast] Plugin ${packageName} broadcast driver "${driverName}" must export send().`)
  }

  return {
    send: candidate.send as BroadcastDriver['send'],
  }
}

export async function loadBroadcastPluginDrivers(projectRoot = process.cwd()): Promise<void> {
  const root = projectRoot
  if (loadedProjectRoots.has(root)) {
    return
  }

  const contributions = await loadHoloPluginContributionModules(root, 'broadcast', 'drivers')

  for (const contribution of contributions) {
    const previous = getRegisteredBroadcastDriver(contribution.name)
    const driver = resolveBroadcastDriver(contribution.module, contribution.plugin.packageName, contribution.name)
    const registered = registerBroadcastDriver(
      contribution.name,
      driver,
      { replace: true },
    )
    const existingPluginDriver = registeredPluginDrivers.get(registered.name)
    registeredPluginDrivers.set(registered.name, {
      driver,
      previous: existingPluginDriver ? existingPluginDriver.previous : previous,
    })
  }

  loadedProjectRoots.add(root)
}

export function resetBroadcastPluginDrivers(): void {
  for (const [driverName, registered] of registeredPluginDrivers) {
    if (getRegisteredBroadcastDriver(driverName) !== registered.driver) {
      continue
    }

    unregisterBroadcastDriver(driverName)
    if (registered.previous) {
      registerBroadcastDriver(driverName, registered.previous, { replace: true })
    }
  }

  loadedProjectRoots.clear()
  registeredPluginDrivers.clear()
}
