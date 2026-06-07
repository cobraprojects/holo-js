import { createRealtimeClientDefinitionModule } from './realtime-definition-transform'

type LoaderContext = {
  cacheable?: () => void
}

export default function realtimeDefinitionLoader(this: LoaderContext, source: string): string {
  this.cacheable?.()
  return createRealtimeClientDefinitionModule(source)
}
