import { assertRealtimeDefinitionTree } from '@holo-js/adapter-shared/realtime-directories'
import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type LoaderContext = {
  cacheable?: () => void
  readonly resourcePath?: string
  readonly rootContext?: string
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
  const options = this.getOptions?.()
  if (!options?.preserveServerHandlers) assertRealtimeDefinitionTree(this.rootContext ?? process.cwd())
  const result = createRealtimeClientDefinitionTransform(source, this.resourcePath ?? '<realtime module>', options)
  if (this.callback) {
    this.callback(null, result.code, result.map)
    return undefined
  }
  return result.code
}
