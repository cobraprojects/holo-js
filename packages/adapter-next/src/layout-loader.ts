import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { compileNextRootLayout } from '@holo-js/adapter-shared/build'

const LAYOUT_FILE = /^layout\.[cm]?[jt]sx?$/

function appDirectory(projectRoot: string): string {
  const rootAppDirectory = join(projectRoot, 'app')
  return existsSync(rootAppDirectory) ? rootAppDirectory : join(projectRoot, 'src', 'app')
}

function isInside(directory: string, parent: string): boolean {
  const path = relative(parent, directory)
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep))
}

function isRootLayout(file: string, projectRoot: string): boolean {
  const app = appDirectory(projectRoot)
  if (!LAYOUT_FILE.test(basename(file)) || !isInside(dirname(file), app)) return false
  for (let directory = dirname(dirname(file)); isInside(directory, app); directory = dirname(directory)) {
    if (readdirSync(directory).some(entry => LAYOUT_FILE.test(entry))) return false
  }
  return true
}

export default function layoutLoader(this: { cacheable?: () => void, readonly resourcePath: string }, source: string): string {
  this.cacheable?.()
  return isRootLayout(this.resourcePath, process.cwd()) ? compileNextRootLayout(source, this.resourcePath) : source
}
