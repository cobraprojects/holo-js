import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { compileNextRootLayout } from '@holo-js/adapter-shared/build'
import { DEFAULT_PAGE_EXTENSIONS, layoutFileNamePattern } from './app-layout-files'

type LayoutLoaderContext = {
  cacheable?: () => void
  readonly resourcePath: string
  getOptions?(): { readonly pageExtensions?: readonly string[] }
}

function appDirectory(projectRoot: string): string {
  const rootAppDirectory = join(projectRoot, 'app')
  return existsSync(rootAppDirectory) ? rootAppDirectory : join(projectRoot, 'src', 'app')
}

function isInside(directory: string, parent: string): boolean {
  const path = relative(parent, directory)
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep))
}

function isRootLayout(file: string, projectRoot: string, layoutFile: RegExp): boolean {
  const app = appDirectory(projectRoot)
  if (!layoutFile.test(basename(file)) || !isInside(dirname(file), app)) return false
  for (let directory = dirname(dirname(file)); isInside(directory, app); directory = dirname(directory)) {
    if (readdirSync(directory).some(entry => layoutFile.test(entry))) return false
  }
  return true
}

export default function layoutLoader(this: LayoutLoaderContext, source: string): string {
  this.cacheable?.()
  const layoutFile = layoutFileNamePattern(this.getOptions?.().pageExtensions ?? DEFAULT_PAGE_EXTENSIONS)
  return isRootLayout(this.resourcePath, process.cwd(), layoutFile) ? compileNextRootLayout(source, this.resourcePath) : source
}
