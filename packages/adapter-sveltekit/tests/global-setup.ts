import { resolve } from 'node:path'
import { collectLibraryBuilds } from '../../../scripts/build-libraries.mjs'
import { rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'

export default async function setup(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  await rebuildStaleWorkspacePackages(workspaceRoot, collectLibraryBuilds(workspaceRoot, [
    '@holo-js/config',
    '@holo-js/validation',
    '@holo-js/forms',
    '@holo-js/auth',
    '@holo-js/adapter-sveltekit',
  ]))
}
