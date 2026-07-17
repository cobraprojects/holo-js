import {
  createRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform,
  stripRealtimeServerHandlers,
} from '../src/realtime-definition-transform'
import { runRealtimeAdapterContract } from '../../../tests/support/realtime-adapter-contract'

runRealtimeAdapterContract({
  adapterName: '@holo-js/adapter-next',
  importTarget: '@holo-js/adapter-next/realtime',
  createModule: createRealtimeClientDefinitionModule,
  createTransform: createRealtimeClientDefinitionTransform,
  stripHandlers: stripRealtimeServerHandlers,
})
