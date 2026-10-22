import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderLauncher, writeLauncher } from '../../../tests/support/launchers'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('launcher rendering on win32', () => {
  it('renders a .cmd that runs a sibling script through the node binary', () => {
    expect(renderLauncher('npm', { node: { sibling: 'shim.mjs' }, leadingArgs: ['npm'] }, 'win32', 'C:\\node\\node.exe')).toEqual({
      fileName: 'npm.cmd',
      contents: '@"C:\\node\\node.exe" "%~dp0shim.mjs" npm %*\r\n',
    })
  })

  it('renders a .cmd that runs an absolute script with spaces in its path', () => {
    expect(renderLauncher('holo', { node: { absolute: 'C:\\repo with spaces\\holo.mjs' } }, 'win32', 'C:\\node\\node.exe')).toEqual({
      fileName: 'holo.cmd',
      contents: '@"C:\\node\\node.exe" "C:\\repo with spaces\\holo.mjs" %*\r\n',
    })
  })

  it('renders a .cmd that exits with the requested status', () => {
    expect(renderLauncher('nuxt', { exit: 0 }, 'win32')).toEqual({
      fileName: 'nuxt.cmd',
      contents: '@exit /b 0\r\n',
    })
  })

  it('renders a .cmd that echoes a message and forwards arguments', () => {
    expect(renderLauncher('npm', { echo: 'real npm:' }, 'win32')).toEqual({
      fileName: 'npm.cmd',
      contents: '@echo real npm: %*\r\n',
    })
  })
})

describe('launcher rendering on POSIX', () => {
  it('renders an sh launcher that execs node on a sibling script', () => {
    expect(renderLauncher('npm', { node: { sibling: 'shim.mjs' }, leadingArgs: ['npm'] }, 'linux')).toEqual({
      fileName: 'npm',
      contents: '#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" \'npm\' "$@"\n',
    })
  })

  it('quotes an absolute script path that contains an apostrophe', () => {
    expect(renderLauncher('holo', { node: { absolute: "/opt/it's/holo.mjs" } }, 'linux').contents).toBe(
      "#!/bin/sh\nexec node '/opt/it'\\''s/holo.mjs' \"$@\"\n",
    )
  })

  it('renders an sh launcher that exits with the requested status', () => {
    expect(renderLauncher('yarn', { exit: 3 }, 'linux')).toEqual({
      fileName: 'yarn',
      contents: '#!/bin/sh\nexit 3\n',
    })
  })
})

describe('launcher writing', () => {
  it('replaces an existing symlink instead of writing through it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'holo-launcher-'))
    tempDirs.push(base)
    const bin = join(base, 'bin')
    await mkdir(bin)
    const target = join(base, 'real.mjs')
    await writeFile(target, 'original\n')
    await symlink(target, join(bin, 'holo'))

    await writeLauncher(bin, 'holo', { node: { absolute: target } })

    expect(await readFile(target, 'utf8')).toBe('original\n')
    expect(await readFile(join(bin, 'holo'), 'utf8')).toBe(`#!/bin/sh\nexec node '${target}' "$@"\n`)
  })
})
