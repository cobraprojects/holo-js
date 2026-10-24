import {
  createRealtimeClientDefinitionModule as createSharedRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform as createSharedRealtimeClientDefinitionTransform,
  type RealtimeDefinitionTransformResult,
  stripRealtimeServerHandlers,
} from '@holo-js/adapter-shared/build'

export { stripRealtimeServerHandlers }

export function createRealtimeClientDefinitionModule(source: string, filePath: string): string {
  return createSharedRealtimeClientDefinitionModule(source, '@holo-js/adapter-sveltekit/realtime', filePath)
}

export function createRealtimeClientDefinitionTransform(source: string, filePath: string): RealtimeDefinitionTransformResult {
  return createSharedRealtimeClientDefinitionTransform(source, '@holo-js/adapter-sveltekit/realtime', filePath)
}
