import { basename, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { LoadedEnvironment, HoloAppEnv } from './types'

type EnvScalar = string | number | boolean

type LoadEnvironmentOptions = {
  cwd: string
  envName?: string
  processEnv?: NodeJS.ProcessEnv
}

type EnvRuntimeMode = 'resolve' | 'capture'

type EnvPlaceholder = {
  readonly __holoEnv: true
  readonly key: string
  readonly fallback?: EnvScalar
}

type EnvRuntimeState = {
  values?: Readonly<Record<string, string>>
  mode: EnvRuntimeMode
}

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const exportPrefix = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed
    const separator = exportPrefix.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const key = exportPrefix.slice(0, separator).trim()
    let value = exportPrefix.slice(separator + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')

    values[key] = value
  }

  return values
}

async function readEnvFile(filePath: string): Promise<Record<string, string> | undefined> {
  try {
    const contents = await readFile(filePath, 'utf8')
    return parseEnvFile(contents)
  } catch {
    return undefined
  }
}

export function resolveAppEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env,
): HoloAppEnv {
  const value = processEnv.HOLO_ENV ?? processEnv.APP_ENV ?? processEnv.NODE_ENV
  if (value === 'production' || value === 'development' || value === 'test') {
    return value
  }

  return 'development'
}

export function resolveEnvironmentFileOrder(envName: HoloAppEnv): string[] {
  if (envName === 'production') {
    return ['.env', '.env.production', '.env.prod', '.env.local']
  }

  if (envName === 'test') {
    return ['.env', '.env.test']
  }

  return ['.env', '.env.development', '.env.local']
}

export async function loadEnvironment(
  options: LoadEnvironmentOptions,
): Promise<LoadedEnvironment> {
  const cwd = resolve(options.cwd)
  const envName = options.envName
    ? resolveAppEnvironment({ ...options.processEnv, HOLO_ENV: options.envName })
    : resolveAppEnvironment(options.processEnv)
  const loadedFiles: string[] = []
  const warnings: string[] = []
  const values: Record<string, string> = {}
  const productionFileNames = new Set<string>()

  for (const relativeName of resolveEnvironmentFileOrder(envName)) {
    const filePath = join(cwd, relativeName)
    const fileValues = await readEnvFile(filePath)
    if (!fileValues) {
      continue
    }

    loadedFiles.push(filePath)

    if (envName === 'production' && (relativeName === '.env.production' || relativeName === '.env.prod')) {
      productionFileNames.add(relativeName)
    }

    if (envName === 'production' && relativeName === '.env.prod' && productionFileNames.has('.env.production')) {
      warnings.push(`Ignoring ${basename(filePath)} because .env.production is present.`)
      continue
    }

    Object.assign(values, fileValues)
  }

  const processEnv = options.processEnv ?? process.env
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === 'string') {
      values[key] = value
    }
  }

  return {
    name: envName,
    values: Object.freeze({ ...values }),
    loadedFiles: Object.freeze([...loadedFiles]),
    warnings: Object.freeze([...warnings]),
  }
}

function getEnvRuntimeState(): EnvRuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoEnvRuntime__?: EnvRuntimeState
  }

  runtime.__holoEnvRuntime__ ??= {
    mode: 'resolve',
  }

  return runtime.__holoEnvRuntime__
}

export function configureEnvRuntime(
  values?: Readonly<Record<string, string>>,
  options: { mode?: EnvRuntimeMode } = {},
): void {
  const state = getEnvRuntimeState()
  state.values = values
  state.mode = options.mode ?? 'resolve'
}

function coerceEnvScalar<TValue extends EnvScalar>(
  runtimeValue: string,
  fallback: TValue,
): TValue {
  if (typeof fallback === 'boolean') {
    const normalized = runtimeValue.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true as TValue
    }

    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false as TValue
    }

    return fallback
  }

  if (typeof fallback === 'number') {
    const parsed = Number(runtimeValue)
    return (Number.isFinite(parsed) ? parsed : fallback) as TValue
  }

  return runtimeValue as TValue
}

export function env(key: string): string
export function env<TValue extends EnvScalar>(key: string, fallback: TValue): TValue
export function env<TValue extends EnvScalar>(key: string, fallback?: TValue): string | TValue {
  const state = getEnvRuntimeState()

  if (process.env.HOLO_CAPTURE_ENV === '1' || state.mode === 'capture') {
    return Object.freeze({
      __holoEnv: true,
      key,
      ...(typeof fallback !== 'undefined' ? { fallback } : {}),
    }) as unknown as string | TValue
  }

  const runtimeValue = state.values?.[key]
  if (typeof runtimeValue === 'string') {
    return typeof fallback === 'undefined'
      ? runtimeValue
      : coerceEnvScalar(runtimeValue, fallback)
  }

  const processValue = process.env[key]
  if (typeof processValue === 'string') {
    return typeof fallback === 'undefined'
      ? processValue
      : coerceEnvScalar(processValue, fallback)
  }

  if (typeof fallback !== 'undefined') {
    return fallback
  }

  return ''
}

export function isEnvPlaceholder(value: unknown): value is EnvPlaceholder {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Partial<EnvPlaceholder>).__holoEnv === true
    && typeof (value as Partial<EnvPlaceholder>).key === 'string'
}

export function resolveEnvPlaceholders<TValue>(
  value: TValue,
  envValues: Readonly<Record<string, string>>,
): TValue {
  if (isEnvPlaceholder(value)) {
    const runtimeValue = envValues[value.key]
    if (typeof runtimeValue === 'string') {
      if (typeof value.fallback === 'undefined') {
        return runtimeValue as TValue
      }

      return coerceEnvScalar(runtimeValue, value.fallback) as TValue
    }

    if (typeof value.fallback !== 'undefined') {
      return value.fallback as TValue
    }

    return '' as TValue
  }

  if (Array.isArray(value)) {
    return value.map(entry => resolveEnvPlaceholders(entry, envValues)) as TValue
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvPlaceholders(entry, envValues)]),
    ) as TValue
  }

  return value
}
