import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { TestProject } from 'vitest/node'
import { collectLibraryBuilds } from '../../../scripts/build-libraries.mjs'
import { rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'
import { buildNextFirstVisitApp } from './support/next-first-visit-app'

declare module 'vitest' {
  export interface ProvidedContext {
    nextFirstVisitRoot: string
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')
  await rebuildStaleWorkspacePackages(workspaceRoot, collectLibraryBuilds(workspaceRoot, [
    '@holo-js/config',
    '@holo-js/validation',
    '@holo-js/forms',
    '@holo-js/auth',
    '@holo-js/adapter-next',
  ]))
  const nextFirstVisitRoot = await buildNextFirstVisitApp()
  project.provide('nextFirstVisitRoot', nextFirstVisitRoot)
  return () => rm(nextFirstVisitRoot, { recursive: true, force: true })
}
