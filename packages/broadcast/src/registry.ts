import type {
  BroadcastDriver,
  RegisterBroadcastDriverOptions,
  RegisteredBroadcastDriver,
} from './contracts'

const registeredDrivers = new Map<string, BroadcastDriver>()

function normalizeDriverName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error('[Holo Broadcast] Broadcast driver names must be non-empty strings.')
  }

  return normalized
}

export function registerBroadcastDriver(
  name: string,
  driver: BroadcastDriver,
  options: RegisterBroadcastDriverOptions = {},
): RegisteredBroadcastDriver {
  const normalizedName = normalizeDriverName(name)
  if (typeof driver?.send !== 'function') {
    throw new Error('[Holo Broadcast] Broadcast drivers must define a send(...) function.')
  }

  if (registeredDrivers.has(normalizedName) && options.replace !== true) {
    throw new Error(`[Holo Broadcast] Broadcast driver "${normalizedName}" is already registered.`)
  }

  registeredDrivers.set(normalizedName, driver)

  return Object.freeze({
    name: normalizedName,
    driver,
  })
}

export function getRegisteredBroadcastDriver(name: string): BroadcastDriver | undefined {
  return registeredDrivers.get(normalizeDriverName(name))
}

export function listRegisteredBroadcastDrivers(): readonly RegisteredBroadcastDriver[] {
  return Object.freeze(
    [...registeredDrivers.entries()].map(([name, driver]) => Object.freeze({ name, driver })),
  )
}

export function resetBroadcastDriverRegistry(): void {
  registeredDrivers.clear()
}

export const broadcastRegistryInternals = {
  normalizeDriverName,
}
