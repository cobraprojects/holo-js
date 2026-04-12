import type {
  MailDriver,
  RegisterMailDriverOptions,
  RegisteredMailDriver,
} from './contracts'

function normalizeDriverName(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('[@holo-js/mail] Mail driver names must be non-empty strings.')
  }

  return normalized
}

function getRegistry(): Map<string, RegisteredMailDriver> {
  const runtime = globalThis as typeof globalThis & {
    __holoMailDriverRegistry__?: Map<string, RegisteredMailDriver>
  }

  runtime.__holoMailDriverRegistry__ ??= new Map()
  return runtime.__holoMailDriverRegistry__
}

export function registerMailDriver<TDriver extends string>(
  name: TDriver,
  driver: MailDriver,
  options: RegisterMailDriverOptions = {},
): void {
  const normalizedName = normalizeDriverName(name)
  if (typeof driver?.send !== 'function') {
    throw new Error(`[@holo-js/mail] Mail driver "${normalizedName}" must define send().`)
  }

  const registry = getRegistry()
  if (registry.has(normalizedName) && options.replaceExisting !== true) {
    throw new Error(`[@holo-js/mail] Mail driver "${normalizedName}" is already registered.`)
  }

  registry.set(normalizedName, Object.freeze({
    name: normalizedName,
    driver,
  }))
}

export function getRegisteredMailDriver<TDriver extends string>(
  name: TDriver,
): RegisteredMailDriver<TDriver> | undefined {
  return getRegistry().get(normalizeDriverName(name)) as RegisteredMailDriver<TDriver> | undefined
}

export function listRegisteredMailDrivers(): readonly RegisteredMailDriver[] {
  return Object.freeze([...getRegistry().values()])
}

export function resetMailDriverRegistry(): void {
  getRegistry().clear()
}

export const mailRegistryInternals = {
  getRegistry,
  normalizeDriverName,
}
