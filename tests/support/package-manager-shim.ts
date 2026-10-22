import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const shimmedPackageManagers = ['bun', 'npm', 'pnpm', 'yarn'] as const

export type PackageManagerShims = {
  readonly root: string
  readonly installLog: string
}

export type PackageManagerLauncher = {
  readonly fileName: string
  readonly contents: string
}

const runnerSource = fileURLToPath(new URL('./package-manager-shim-runner.mjs', import.meta.url))

export function renderLauncher(name: string, platform: NodeJS.Platform, nodePath: string = process.execPath): PackageManagerLauncher {
  if (platform === 'win32') {
    return {
      fileName: `${name}.cmd`,
      contents: `@"${nodePath}" "%~dp0shim.mjs" ${name} %*\r\n`,
    }
  }
  return {
    fileName: name,
    contents: `#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" ${name} "$@"\n`,
  }
}

export async function createPackageManagerShims(root: string): Promise<PackageManagerShims> {
  await copyFile(runnerSource, join(root, 'shim.mjs'))
  for (const name of shimmedPackageManagers) {
    const launcher = renderLauncher(name, process.platform)
    await writeFile(join(root, launcher.fileName), launcher.contents, { mode: 0o755 })
  }
  return { root, installLog: join(root, 'install-requests.log') }
}
