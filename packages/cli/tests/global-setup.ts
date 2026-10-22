import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectLibraryBuilds } from '../../../scripts/build-libraries.mjs'
import { generateCliWorkspaceCatalog } from '../../../scripts/generate-cli-workspace-catalog.mjs'
import { buildWorkspacePackage, rebuildStaleWorkspacePackages, type WorkspacePackageBuild } from '../../../tests/support/workspace-dist'

export async function prepareWorkspaceDists(
  workspaceRoot: string,
  build: WorkspacePackageBuild = buildWorkspacePackage,
): Promise<string[]> {
  const catalog = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).workspaces.catalog
  const names = Object.keys(catalog).filter(name => name.startsWith('@holo-js/'))
  const buildWithCatalog: WorkspacePackageBuild = async (name, root) => {
    if (name === '@holo-js/cli') await generateCliWorkspaceCatalog(root)
    await build(name, root)
  }
  return rebuildStaleWorkspacePackages(workspaceRoot, collectLibraryBuilds(workspaceRoot, names), buildWithCatalog)
}

export default async function setup(): Promise<void> {
  const rebuilt = await prepareWorkspaceDists(resolve(import.meta.dirname, '../../..'))
  console.log(rebuilt.length > 0
    ? `Rebuilt stale workspace packages: ${rebuilt.join(', ')}`
    : 'Workspace dists are current; nothing rebuilt.')
}
