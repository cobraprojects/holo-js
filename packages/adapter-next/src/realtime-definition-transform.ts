import {
  createRealtimeClientDefinitionModule as createSharedRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform as createSharedRealtimeClientDefinitionTransform,
  type RealtimeDefinitionTransformOptions,
  type RealtimeDefinitionTransformResult,
  stripRealtimeServerHandlers,
} from '@holo-js/adapter-shared'

export { stripRealtimeServerHandlers }

export function createRealtimeClientDefinitionModule(source: string): string {
  return createSharedRealtimeClientDefinitionModule(source, '@holo-js/adapter-next/realtime')
}

export function createRealtimeClientDefinitionTransform(
  source: string,
  options: RealtimeDefinitionTransformOptions = {},
): RealtimeDefinitionTransformResult {
  return createSharedRealtimeClientDefinitionTransform(source, '@holo-js/adapter-next/realtime', options)
}
