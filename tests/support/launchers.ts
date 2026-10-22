import { rmSync, writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type LauncherScript = { readonly sibling: string } | { readonly absolute: string }

export type LauncherSpec =
  | { readonly node: LauncherScript, readonly leadingArgs?: readonly string[] }
  | { readonly exit: number }
  | { readonly echo: string }

export type Launcher = {
  readonly fileName: string
  readonly contents: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function renderLauncher(
  name: string,
  spec: LauncherSpec,
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): Launcher {
  const isWindows = platform === 'win32'
  const fileName = isWindows ? `${name}.cmd` : name

  if ('exit' in spec) {
    return {
      fileName,
      contents: isWindows ? `@exit /b ${spec.exit}\r\n` : `#!/bin/sh\nexit ${spec.exit}\n`,
    }
  }

  if ('echo' in spec) {
    return {
      fileName,
      contents: isWindows ? `@echo ${spec.echo} %*\r\n` : `#!/bin/sh\necho "${spec.echo} $*"\n`,
    }
  }

  const leadingArgs = spec.leadingArgs ?? []
  if (isWindows) {
    const scriptPath = 'sibling' in spec.node ? `%~dp0${spec.node.sibling}` : spec.node.absolute
    const args = [...leadingArgs, '%*'].join(' ')
    return { fileName, contents: `@"${nodePath}" "${scriptPath}" ${args}\r\n` }
  }

  const scriptRef = 'sibling' in spec.node
    ? `"$(dirname "$0")/${spec.node.sibling}"`
    : shellQuote(spec.node.absolute)
  const args = [...leadingArgs.map(shellQuote), '"$@"'].join(' ')
  return { fileName, contents: `#!/bin/sh\nexec node ${scriptRef} ${args}\n` }
}

export function writeLauncherSync(directory: string, name: string, spec: LauncherSpec): string {
  const launcher = renderLauncher(name, spec)
  const target = join(directory, launcher.fileName)
  rmSync(target, { force: true })
  writeFileSync(target, launcher.contents, { mode: 0o755 })
  return target
}

export async function writeLauncher(directory: string, name: string, spec: LauncherSpec): Promise<string> {
  const launcher = renderLauncher(name, spec)
  const target = join(directory, launcher.fileName)
  await rm(target, { force: true })
  await writeFile(target, launcher.contents, { mode: 0o755 })
  return target
}
