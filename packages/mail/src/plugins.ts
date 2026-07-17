import {
  loadHoloPluginContributionModules,
  loadHoloPluginDefinitions,
} from '@holo-js/kernel'
import { getRegisteredMailDriver, registerMailDriver, unregisterMailDriver } from './registry'
import type { MailDriver } from './contracts'

const loadedProjectRoots = new Set<string>()
const registeredPluginDrivers = new Map<string, {
  readonly driver: MailDriver
  readonly previous: MailDriver | undefined
}>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveMailDriver(moduleValue: unknown, packageName: string, driverName: string): MailDriver {
  const candidate = isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
    ? moduleValue.default
    : isRecord(moduleValue) && typeof moduleValue.driver !== 'undefined'
      ? moduleValue.driver
      : moduleValue

  if (!isRecord(candidate) || typeof candidate.send !== 'function') {
    throw new Error(`[@holo-js/mail] Plugin ${packageName} mail driver "${driverName}" must export send().`)
  }

  return {
    send: candidate.send as MailDriver['send'],
  }
}

export async function loadMailPluginDrivers(
  projectRoot = process.cwd(),
  pluginNames: readonly string[] = [],
): Promise<void> {
  const loadKey = `${projectRoot}\0${[...pluginNames].sort().join('\0')}`
  if (loadedProjectRoots.has(loadKey)) {
    return
  }

  const plugins = await loadHoloPluginDefinitions(projectRoot, pluginNames)
  const contributions = await loadHoloPluginContributionModules(projectRoot, plugins, 'mail', 'drivers')

  for (const contribution of contributions) {
    const previous = getRegisteredMailDriver(contribution.name)
    const driver = resolveMailDriver(contribution.module, contribution.plugin.packageName, contribution.name)
    registerMailDriver(
      contribution.name,
      driver,
      { replaceExisting: true },
    )
    const registered = getRegisteredMailDriver(contribution.name)
    if (registered) {
      const existingPluginDriver = registeredPluginDrivers.get(registered.name)
      registeredPluginDrivers.set(registered.name, {
        driver,
        previous: existingPluginDriver ? existingPluginDriver.previous : previous?.driver,
      })
    }
  }

  loadedProjectRoots.add(loadKey)
}

export function resetMailPluginDrivers(): void {
  for (const [driverName, registered] of registeredPluginDrivers) {
    if (getRegisteredMailDriver(driverName)?.driver !== registered.driver) {
      continue
    }

    unregisterMailDriver(driverName)
    if (registered.previous) {
      registerMailDriver(driverName, registered.previous, { replaceExisting: true })
    }
  }

  loadedProjectRoots.clear()
  registeredPluginDrivers.clear()
}
