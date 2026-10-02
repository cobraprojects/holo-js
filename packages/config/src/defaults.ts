import {
  DEFAULT_HOLO_PROJECT_PATHS,
  normalizeHoloProjectConfig,
} from '@holo-js/kernel'
import type {
  NormalizedHoloAppConfig,
  HoloAppConfig,
  HoloAppEnv,
} from './types'

export const DEFAULT_APP_NAME = 'Holo'

export const holoAppDefaults: Readonly<NormalizedHoloAppConfig> = Object.freeze({
  name: DEFAULT_APP_NAME,
  key: '',
  url: 'http://localhost:3000',
  timezone: 'UTC',
  debug: true,
  env: 'development',
  plugins: Object.freeze([]),
  paths: Object.freeze({ ...DEFAULT_HOLO_PROJECT_PATHS }),
  models: Object.freeze([]),
  migrations: Object.freeze([]),
  seeders: Object.freeze([]),
})

export function normalizeAppEnv(value: string | undefined, fallback: HoloAppEnv = 'development'): HoloAppEnv {
  if (!value) {
    return fallback
  }

  if (value === 'development' || value === 'production' || value === 'test') {
    return value
  }

  return fallback
}

export function normalizeAppConfig(
  config: HoloAppConfig = {},
): NormalizedHoloAppConfig {
  const project = normalizeHoloProjectConfig(config)
  let timezone = config.timezone ?? holoAppDefaults.timezone
  try {
    if (timezone.startsWith('+') || timezone.startsWith('-')) throw new RangeError()
    timezone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    throw new Error(`Invalid application timezone: ${timezone}`)
  }
  const rawDebug = (config as { debug?: unknown }).debug
  const debug = typeof rawDebug === 'string'
    ? !['false', '0', 'off', 'no'].includes(rawDebug.trim().toLowerCase())
    : config.debug

  return Object.freeze({
    name: config.name ?? holoAppDefaults.name,
    key: config.key ?? holoAppDefaults.key,
    url: config.url ?? holoAppDefaults.url,
    timezone,
    debug: debug ?? holoAppDefaults.debug,
    env: normalizeAppEnv(config.env, holoAppDefaults.env),
    plugins: Object.freeze([...new Set((config.plugins ?? [])
      .map(plugin => plugin.trim())
      .filter(plugin => plugin.length > 0))]),
    paths: project.paths,
    models: project.models,
    migrations: project.migrations,
    seeders: project.seeders,
  })
}
