import { compileNextRoute } from '@holo-js/adapter-shared/build'

export default function routeLoader(this: { cacheable?: () => void, readonly resourcePath: string }, source: string): string {
  this.cacheable?.()
  return compileNextRoute(source, this.resourcePath)
}
