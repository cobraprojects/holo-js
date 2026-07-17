export interface HoloConfigNormalizerContext {
  readonly values: Readonly<Record<string, object>>
  get<TValue extends object>(name: string): TValue | undefined
  has(name: string): boolean
}

export interface HoloConfigNormalizer<TInput = unknown, TOutput extends object = object> {
  readonly name: string
  readonly dependencies?: readonly string[]
  normalize(value: TInput | undefined, context: HoloConfigNormalizerContext): TOutput
}

type RegisteredConfigNormalizer = HoloConfigNormalizer & {
  readonly dependencies: readonly string[]
}

const configNormalizerRuntime = globalThis as typeof globalThis & {
  __holoConfigNormalizers__?: Map<string, RegisteredConfigNormalizer>
}
configNormalizerRuntime.__holoConfigNormalizers__ ??= new Map()
const configNormalizers = configNormalizerRuntime.__holoConfigNormalizers__

export function registerConfigNormalizer<TInput, TOutput extends object>(
  normalizer: HoloConfigNormalizer<TInput, TOutput>,
): () => void {
  const name = normalizer.name.trim()
  if (!name) {
    throw new TypeError('Holo config normalizer names must be non-empty strings.')
  }

  const registered = Object.freeze({
    ...normalizer,
    name,
    dependencies: Object.freeze([...new Set(normalizer.dependencies ?? [])]),
  }) as RegisteredConfigNormalizer
  configNormalizers.set(name, registered)

  return () => {
    if (configNormalizers.get(name) === registered) {
      configNormalizers.delete(name)
    }
  }
}

export function composeRegisteredConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  initialValues: Readonly<Record<string, object>>,
): Readonly<Record<string, object>> {
  const values: Record<string, object> = { ...initialValues }
  const remaining = new Map(configNormalizers)
  const context: HoloConfigNormalizerContext = Object.freeze({
    get<TValue extends object>(name: string): TValue | undefined {
      return values[name] as TValue | undefined
    },
    has(name: string): boolean {
      return Object.hasOwn(rawConfig, name)
    },
    get values() {
      return Object.freeze({ ...values })
    },
  })

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(normalizer => normalizer.dependencies.every(dependency => dependency in values))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (ready.length === 0) {
      throw new Error(`Holo config normalizers have unresolved dependencies: ${[...remaining.keys()].sort().join(', ')}.`)
    }

    for (const normalizer of ready) {
      values[normalizer.name] = normalizer.normalize(rawConfig[normalizer.name], context)
      remaining.delete(normalizer.name)
    }
  }

  return Object.freeze(values)
}

export function resetConfigNormalizers(): void {
  configNormalizers.clear()
}

export const configRegistryInternals = {
  getRegisteredNames(): readonly string[] {
    return Object.freeze([...configNormalizers.keys()].sort())
  },
}
