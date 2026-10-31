import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { compileNextRootLayout } from '@holo-js/adapter-shared/build'
import { DEFAULT_PAGE_EXTENSIONS, layoutFileNamePattern } from './app-layout-files'

const CLIENT_LAYOUT_QUERY = '?holo-client-layout'

type NextBundler = 'turbopack' | 'webpack'

type LayoutLoaderContext = {
  cacheable?: () => void
  readonly resourcePath: string
  readonly resourceQuery?: string
  addDependency?(file: string): void
  addContextDependency?(directory: string): void
  getOptions?(): { readonly pageExtensions?: readonly string[], readonly bundler?: NextBundler }
}

function appDirectory(projectRoot: string): string {
  const rootAppDirectory = join(projectRoot, 'app')
  return existsSync(rootAppDirectory) ? rootAppDirectory : join(projectRoot, 'src', 'app')
}

function isInside(directory: string, parent: string): boolean {
  const path = relative(parent, directory)
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep))
}

function isRootLayout(file: string, projectRoot: string, layoutFile: RegExp, watchDirectory: (directory: string) => void): boolean {
  const app = appDirectory(projectRoot)
  if (!layoutFile.test(basename(file)) || !isInside(dirname(file), app)) return false
  for (let directory = dirname(dirname(file)); isInside(directory, app); directory = dirname(directory)) {
    watchDirectory(directory)
    if (readdirSync(directory).some(entry => layoutFile.test(entry))) return false
  }
  return true
}

function writeClientLayoutEntry(layout: string, projectRoot: string): string {
  const name = createHash('sha256').update(relative(projectRoot, layout)).digest('hex').slice(0, 16)
  const entry = join(projectRoot, '.holo-js', 'generated', 'next', 'client-layouts', `${name}.tsx`)
  const source = [`'use client'`, `export * from ${JSON.stringify(layout)}`, `export { default } from ${JSON.stringify(layout)}`, ''].join('\n')
  if (!existsSync(entry) || readFileSync(entry, 'utf8') !== source) {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, source)
  }
  return entry
}


export default function layoutLoader(this: LayoutLoaderContext, source: string): string {
  this.cacheable?.()
  if (this.resourceQuery === CLIENT_LAYOUT_QUERY) return source
  const options = this.getOptions?.()
  const projectRoot = process.cwd()
  const layoutFile = layoutFileNamePattern(options?.pageExtensions ?? DEFAULT_PAGE_EXTENSIONS)
  if (!isRootLayout(this.resourcePath, projectRoot, layoutFile, directory => this.addContextDependency?.(directory))) return source
  return compileNextRootLayout(source, this.resourcePath, () => {
    if (options?.bundler !== 'webpack') return `./${basename(this.resourcePath)}${CLIENT_LAYOUT_QUERY}`
    const entry = writeClientLayoutEntry(this.resourcePath, projectRoot)
    this.addDependency?.(entry)
    return entry
  })
}
