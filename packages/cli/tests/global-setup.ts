import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectLibraryBuilds } from '../../../scripts/build-libraries.mjs'
import { rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'

// Runs once before the integration suite's workers start, so the suite links only current workspace builds. The
// rebuilds happen here, in the main process, rather than inside a worker's beforeAll.
export default async function setup(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  const catalog = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).workspaces.catalog
  const names = Object.keys(catalog).filter(name => name.startsWith('@holo-js/'))
  const rebuilt = await rebuildStaleWorkspacePackages(workspaceRoot, collectLibraryBuilds(workspaceRoot, names))
  console.log(rebuilt.length > 0
    ? `Rebuilt stale workspace packages: ${rebuilt.join(', ')}`
    : 'Workspace dists are current; nothing rebuilt.')
}
