import { type NextModuleInputSourceMap, transformNextRoute } from '@holo-js/adapter-shared/build'
import { type ModuleTransformLoaderContext, runModuleTransform } from './module-transform-loader'

export default function routeLoader(this: ModuleTransformLoaderContext, source: string, inputMap?: NextModuleInputSourceMap | null): string | undefined {
  return runModuleTransform(this, transformNextRoute, source, inputMap)
}
