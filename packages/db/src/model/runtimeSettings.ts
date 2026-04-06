import type { AnyModelDefinition } from './types'

type RuntimeSettings = {
  preventLazyLoading?: boolean
  preventAccessingMissingAttributes?: boolean
  automaticEagerLoading?: boolean
}

const runtimeSettings = new WeakMap<AnyModelDefinition, RuntimeSettings>()

export function getModelRuntimeSettings(definition: AnyModelDefinition): Required<RuntimeSettings> {
  const overrides = runtimeSettings.get(definition) ?? {}

  return {
    preventLazyLoading: overrides.preventLazyLoading ?? definition.preventLazyLoading,
    preventAccessingMissingAttributes: overrides.preventAccessingMissingAttributes ?? definition.preventAccessingMissingAttributes,
    automaticEagerLoading: overrides.automaticEagerLoading ?? definition.automaticEagerLoading,
  }
}

export function setPreventLazyLoading(
  definition: AnyModelDefinition,
  value: boolean,
): void {
  const current = runtimeSettings.get(definition) ?? {}
  runtimeSettings.set(definition, {
    ...current,
    preventLazyLoading: value,
  })
}

export function setPreventAccessingMissingAttributes(
  definition: AnyModelDefinition,
  value: boolean,
): void {
  const current = runtimeSettings.get(definition) ?? {}
  runtimeSettings.set(definition, {
    ...current,
    preventAccessingMissingAttributes: value,
  })
}

export function setAutomaticEagerLoading(
  definition: AnyModelDefinition,
  value: boolean,
): void {
  const current = runtimeSettings.get(definition) ?? {}
  runtimeSettings.set(definition, {
    ...current,
    automaticEagerLoading: value,
  })
}
