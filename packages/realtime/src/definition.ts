import type {
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinitionMetadata,
} from './contracts'

const REALTIME_DEFINITION_MARKER = Symbol.for('holo-js.realtime.definition')

type DefinitionState = {
  nextDefinitionId: number
}

function getDefinitionState(): DefinitionState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeDefinitions__?: DefinitionState
  }

  runtime.__holoRealtimeDefinitions__ ??= {
    nextDefinitionId: 0,
  }
  return runtime.__holoRealtimeDefinitions__
}

export function nextDefinitionName(kind: 'query' | 'mutation'): string {
  const state = getDefinitionState()
  state.nextDefinitionId += 1
  return `realtime.${kind}.${state.nextDefinitionId}`
}

export function markDefinition<TDefinition extends object>(definition: TDefinition): TDefinition {
  return Object.freeze(Object.defineProperty(definition, REALTIME_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  }))
}

export function isRealtimeDefinition(value: unknown): value is RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata {
  return !!(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && (value as { readonly [REALTIME_DEFINITION_MARKER]?: unknown })[REALTIME_DEFINITION_MARKER] === true
  )
}

export const realtimeDefinitionInternals = {
  REALTIME_DEFINITION_MARKER,
  getDefinitionState,
  nextDefinitionName,
}
