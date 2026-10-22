import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

const shimmedPackageManagers = ['bun', 'npm', 'pnpm', 'yarn'] as const

export type PackageManagerShims = {
  readonly root: string
  readonly installLog: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function findExecutableOnPath(name: string, searchPath: string): string | undefined {
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
  }
  return undefined
}

export async function createPackageManagerShims(root: string, searchPath: string): Promise<PackageManagerShims> {
  const installLog = join(root, 'install-requests.log')
  for (const name of shimmedPackageManagers) {
    const realBinary = findExecutableOnPath(name, searchPath)
    const forward = realBinary
      ? `exec ${shellQuote(realBinary)} "$@"`
      : `echo ${shellQuote(`${name} is not installed`)} >&2\nexit 127`
    await writeFile(join(root, name), [
      '#!/bin/sh',
      'if [ "$1" = "install" ]; then',
      `  pwd -P >> ${shellQuote(installLog)}`,
      '  if [ -f install-hook.cjs ]; then node install-hook.cjs || exit $?; fi',
      '  exit 0',
      'fi',
      forward,
      '',
    ].join('\n'), { mode: 0o755 })
  }
  return { root, installLog }
}
