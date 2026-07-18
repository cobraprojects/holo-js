import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type LoaderContext = {
  cacheable?: () => void
  callback?(error: null, code: string, map: object): void
  getOptions?(): {
    readonly preserveServerHandlers?: boolean
  }
  readonly resourceQuery?: string
}

export default function realtimeDefinitionLoader(this: LoaderContext, source: string): string | undefined {
  this.cacheable?.()
  if (this.resourceQuery === '?holo-realtime-server') {
    return source
  }
  const result = createRealtimeClientDefinitionTransform(source, this.getOptions?.())
  if (this.callback) {
    this.callback(null, result.code, result.map)
    return undefined
  }
  return result.code
}
