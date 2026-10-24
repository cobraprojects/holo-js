import {
  createRealtimeClientDefinitionModule as createSharedRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform as createSharedRealtimeClientDefinitionTransform,
  type RealtimeDefinitionTransformResult,
} from '@holo-js/adapter-shared/build'

export { stripRealtimeServerHandlers } from '@holo-js/adapter-shared/build'

export function createRealtimeClientDefinitionModule(source: string, filePath: string): string {
  return createSharedRealtimeClientDefinitionModule({ source, importTarget: '@holo-js/adapter-nuxt/realtime', filePath })
}

export function createRealtimeClientDefinitionTransform(source: string, filePath: string): RealtimeDefinitionTransformResult {
  return createSharedRealtimeClientDefinitionTransform({ source, importTarget: '@holo-js/adapter-nuxt/realtime', filePath })
}
