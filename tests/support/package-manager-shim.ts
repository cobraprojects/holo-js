import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeLauncher } from './launchers'

const shimmedPackageManagers = ['bun', 'npm', 'pnpm', 'yarn'] as const

export type PackageManagerShims = {
  readonly root: string
  readonly installLog: string
}

const runnerSource = fileURLToPath(new URL('./package-manager-shim-runner.mjs', import.meta.url))

export async function createPackageManagerShims(root: string): Promise<PackageManagerShims> {
  await copyFile(runnerSource, join(root, 'shim.mjs'))
  for (const name of shimmedPackageManagers) {
    await writeLauncher(root, name, { node: { sibling: 'shim.mjs' }, leadingArgs: [name] })
  }
  return { root, installLog: join(root, 'install-requests.log') }
}
