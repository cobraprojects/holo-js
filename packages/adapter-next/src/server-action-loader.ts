import { type NextModuleInputSourceMap, transformNextServerActions } from '@holo-js/adapter-shared/build'
import { type ModuleTransformLoaderContext, runModuleTransform } from './module-transform-loader'

export default function serverActionLoader(this: ModuleTransformLoaderContext, source: string, inputMap?: NextModuleInputSourceMap | null): string | undefined {
  return runModuleTransform(this, transformNextServerActions, source, inputMap)
}
