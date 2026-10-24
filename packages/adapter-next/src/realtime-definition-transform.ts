import {
  createRealtimeClientDefinitionModule as createSharedRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform as createSharedRealtimeClientDefinitionTransform,
  type RealtimeDefinitionTransformOptions,
  type RealtimeDefinitionTransformResult,
  stripRealtimeServerHandlers,
} from '@holo-js/adapter-shared/build'

export { stripRealtimeServerHandlers }

export function createRealtimeClientDefinitionModule(source: string, filePath: string): string {
  return createSharedRealtimeClientDefinitionModule({ source, importTarget: '@holo-js/adapter-next/realtime', filePath })
}

export function createRealtimeClientDefinitionTransform(
  source: string,
  filePath: string,
  options: RealtimeDefinitionTransformOptions = {},
): RealtimeDefinitionTransformResult {
  return createSharedRealtimeClientDefinitionTransform({ ...options, source, importTarget: '@holo-js/adapter-next/realtime', filePath })
}
