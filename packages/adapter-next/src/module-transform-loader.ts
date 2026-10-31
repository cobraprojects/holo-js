import type { NextModuleInputSourceMap, NextModuleTransform } from '@holo-js/adapter-shared/build'

export type ModuleTransformLoaderContext = {
  cacheable?: () => void
  readonly resourcePath: string
  callback?(error: null, code: string, map?: NextModuleInputSourceMap): void
}

type ModuleTransform = (source: string, filename: string, inputMap?: NextModuleInputSourceMap) => NextModuleTransform | undefined

/** Runs a Next.js module transform as a webpack or Turbopack loader and passes its source map on. */
export function runModuleTransform(
  context: ModuleTransformLoaderContext,
  transform: ModuleTransform,
  source: string,
  incomingMap: NextModuleInputSourceMap | null | undefined,
): string | undefined {
  context.cacheable?.()
  const inputMap = incomingMap ?? undefined
  const result = transform(source, context.resourcePath, inputMap)
  if (!context.callback) return result?.code ?? source
  context.callback(null, result?.code ?? source, result?.map ?? inputMap)
  return undefined
}
