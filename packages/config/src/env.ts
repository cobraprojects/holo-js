import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { LoadedEnvironment, HoloAppEnv } from './types'

type EnvScalar = string | number | boolean

type LoadEnvironmentOptions = {
  cwd: string
  envName?: string
  processEnv?: NodeJS.ProcessEnv
}

type EnvRuntimeState = {
  values?: Readonly<Record<string, string>>
  pendingEvaluation: Promise<void>
  evaluationContext: AsyncLocalStorage<{ active: boolean }>
  envReads: AsyncLocalStorage<Map<string, string | null>>
  envSnapshot: AsyncLocalStorage<EnvSnapshotScope>
}

type EnvSnapshotScope = {
  active: boolean
  values: Readonly<Record<string, string | null>>
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

function readEnvFileSync(filePath: string): Record<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

export function resolveAppEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env,
): HoloAppEnv {
  const value = processEnv.APP_ENV
  if (!value) {
    return 'production'
  }

  if (value === 'production' || value === 'development' || value === 'test') {
    return value
  }

  throw new Error(`Invalid APP_ENV "${value}". Use development, production, or test.`)
}

function selectAppEnvironmentValue(
  envName: string | undefined,
  processEnv: NodeJS.ProcessEnv,
  baseValues: Record<string, string> | undefined,
): string | undefined {
  return envName ?? processEnv.APP_ENV ?? baseValues?.APP_ENV
}

export function resolveProjectAppEnvironmentSync(options: {
  cwd: string
  envName?: string
  processEnv?: NodeJS.ProcessEnv
}): HoloAppEnv {
  const processEnv = options.processEnv ?? process.env
  const baseValues = readEnvFileSync(join(resolve(options.cwd), '.env'))
  return resolveAppEnvironment({
    APP_ENV: selectAppEnvironmentValue(options.envName, processEnv, baseValues),
  })
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
  const processEnv = options.processEnv ?? process.env
  const baseValues = await readEnvFile(join(cwd, '.env'))
  const envName = resolveAppEnvironment({
    APP_ENV: selectAppEnvironmentValue(options.envName, processEnv, baseValues),
  })
  const loadedFiles: string[] = []
  const warnings: string[] = []
  const values: Record<string, string> = {}
  const productionFileNames = new Set<string>()

  for (const relativeName of resolveEnvironmentFileOrder(envName)) {
    const filePath = join(cwd, relativeName)
    const fileValues = relativeName === '.env' ? baseValues : await readEnvFile(filePath)
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

  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === 'string') {
      values[key] = value
    }
  }

  values.APP_ENV = envName

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
    pendingEvaluation: Promise.resolve(),
    evaluationContext: new AsyncLocalStorage(),
    envReads: new AsyncLocalStorage(),
    envSnapshot: new AsyncLocalStorage(),
  }

  return runtime.__holoEnvRuntime__
}

export function configureEnvRuntime(values?: Readonly<Record<string, string>>): void {
  getEnvRuntimeState().values = values
}

async function evaluateConfig<TValue>(
  options: LoadEnvironmentOptions,
  evaluate: (environment: LoadedEnvironment) => Promise<TValue>,
): Promise<TValue> {
  const state = getEnvRuntimeState()
  if (state.evaluationContext.getStore()?.active) {
    throw new Error('Holo config cannot be loaded from an active config evaluation.')
  }

  const evaluation = state.pendingEvaluation.then(async () => {
    const context = { active: true }
    try {
      return await state.evaluationContext.run(context, async () => {
        const environment = await loadEnvironment({
          ...options,
          processEnv: { ...(options.processEnv ?? process.env) },
        })
        const previousValues = state.values
        const previousEntries = new Map(
          Object.keys(environment.values).map(key => [key, process.env[key]] as const),
        )

        try {
          configureEnvRuntime(environment.values)
          Object.assign(process.env, environment.values)

          return await evaluate(environment)
        } finally {
          configureEnvRuntime(previousValues)
          for (const [key, value] of previousEntries) {
            if (value === undefined) {
              Reflect.deleteProperty(process.env, key)
            } else {
              process.env[key] = value
            }
          }
        }
      })
    } finally {
      context.active = false
    }
  })
  state.pendingEvaluation = evaluation.then(() => undefined, () => undefined)
  return evaluation
}

async function recordEnvReads<TValue>(
  callback: () => Promise<TValue>,
): Promise<{ value: TValue, reads: Map<string, string | null> }> {
  const reads = new Map<string, string | null>()
  const value = await getEnvRuntimeState().envReads.run(reads, callback)
  return { value, reads }
}

function withEnvSnapshot<TValue>(
  snapshot: Readonly<Record<string, string | null>> | undefined,
  callback: () => Promise<TValue>,
): Promise<TValue> {
  if (!snapshot) {
    return callback()
  }

  const scope: EnvSnapshotScope = { active: true, values: snapshot }
  return getEnvRuntimeState().envSnapshot.run(scope, async () => {
    try {
      return await callback()
    } finally {
      scope.active = false
    }
  })
}

export const configEvaluationInternals = {
  evaluate: evaluateConfig,
  recordEnvReads,
  withEnvSnapshot,
}

function coerceEnvScalar<TValue extends EnvScalar>(
  key: string,
  runtimeValue: string,
  fallback: TValue,
): TValue {
  if (runtimeValue.trim().length === 0) {
    return fallback
  }

  if (typeof fallback === 'boolean') {
    const normalized = runtimeValue.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true as TValue
    }

    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false as TValue
    }

    throw new Error(`Environment variable "${key}" must be a boolean (true, false, 1, 0, yes, no, on, or off), got "${runtimeValue}".`)
  }

  if (typeof fallback === 'number') {
    const parsed = Number(runtimeValue)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Environment variable "${key}" must be a number, got "${runtimeValue}".`)
    }

    return parsed as TValue
  }

  return runtimeValue as TValue
}

export function env(key: string): string
export function env<TValue extends EnvScalar>(key: string, fallback: TValue): TValue
export function env<TValue extends EnvScalar>(key: string, fallback?: TValue): string | TValue {
  const state = getEnvRuntimeState()
  const scope = state.envSnapshot.getStore()
  if (scope?.active && Object.hasOwn(scope.values, key)) {
    const frozenValue = scope.values[key]
    if (typeof frozenValue === 'string') {
      return typeof fallback === 'undefined'
        ? frozenValue
        : coerceEnvScalar(key, frozenValue, fallback)
    }

    return typeof fallback === 'undefined' ? '' : fallback
  }

  const runtimeValue = state.values?.[key] ?? process.env[key]
  state.envReads.getStore()?.set(key, runtimeValue ?? null)
  if (typeof runtimeValue === 'string') {
    return typeof fallback === 'undefined'
      ? runtimeValue
      : coerceEnvScalar(key, runtimeValue, fallback)
  }

  if (typeof fallback !== 'undefined') {
    return fallback
  }

  return ''
}
