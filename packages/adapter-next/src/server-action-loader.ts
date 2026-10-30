import { compileNextServerActions } from '@holo-js/adapter-shared/build'

export default function serverActionLoader(this: { cacheable?: () => void, readonly resourcePath: string }, source: string): string {
  this.cacheable?.()
  return compileNextServerActions(source, this.resourcePath)
}
