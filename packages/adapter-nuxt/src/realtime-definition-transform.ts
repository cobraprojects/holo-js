import {
  createRealtimeClientDefinitionModule as createSharedRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform as createSharedRealtimeClientDefinitionTransform,
  type RealtimeDefinitionTransformResult,
} from '@holo-js/adapter-shared/build'

export { stripRealtimeServerHandlers } from '@holo-js/adapter-shared/build'

export function createRealtimeClientDefinitionModule(source: string): string {
  return createSharedRealtimeClientDefinitionModule(source, '@holo-js/adapter-nuxt/realtime')
}

export function createRealtimeClientDefinitionTransform(source: string): RealtimeDefinitionTransformResult {
  return createSharedRealtimeClientDefinitionTransform(source, '@holo-js/adapter-nuxt/realtime')
}
