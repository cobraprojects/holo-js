import { resolve } from 'node:path'
import { collectLibraryBuilds } from '../../../scripts/build-libraries.mjs'
import { rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'

// Rebuilds only the stale workspace packages the client declaration test stages, before any test worker starts. Those
// builds take long enough on a slow runner to exceed a test timeout, so they must not run inside the test.
export default async function setup(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  await rebuildStaleWorkspacePackages(workspaceRoot, collectLibraryBuilds(workspaceRoot, [
    '@holo-js/config',
    '@holo-js/validation',
    '@holo-js/forms',
    '@holo-js/auth',
    '@holo-js/adapter-next',
  ]))
}
