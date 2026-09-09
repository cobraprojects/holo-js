import { compileBrowserValidation } from '@holo-js/adapter-shared/build'

export default function validationLoader(this: { cacheable?: () => void; readonly resourcePath?: string }, source: string): string {
  this.cacheable?.()
  return compileBrowserValidation(source, this.resourcePath) ?? source
}
