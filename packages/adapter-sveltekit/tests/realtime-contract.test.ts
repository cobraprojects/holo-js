import {
  createRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform,
  stripRealtimeServerHandlers,
} from '../src/realtime-definition-transform'
import { runRealtimeAdapterContract } from '../../../tests/support/realtime-adapter-contract'

runRealtimeAdapterContract({
  adapterName: '@holo-js/adapter-sveltekit',
  importTarget: '@holo-js/adapter-sveltekit/realtime',
  createModule: createRealtimeClientDefinitionModule,
  createTransform: createRealtimeClientDefinitionTransform,
  stripHandlers: stripRealtimeServerHandlers,
})
