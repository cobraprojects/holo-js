import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackageManagerShims, renderLauncher } from '../../../tests/support/package-manager-shim'
import { resolveExecutable } from '../../../tests/support/package-manager-shim-runner.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function writeFakeRealBinary(directory: string, name: string, message: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(join(directory, `${name}.cmd`), `@echo ${message} %*\r\n`)
    return
  }
  await writeFile(join(directory, name), `#!/bin/sh\necho "${message} $*"\n`, { mode: 0o755 })
}

async function createQuotedFixture() {
  const base = await mkdtemp(join(tmpdir(), "holo-shim-it's-"))
  tempDirs.push(base)
  const realBin = join(base, "real bin's")
  await writeFakeRealBinary(realBin, 'npm', 'real npm:')
  const shimRoot = join(base, "shim's root")
  await mkdir(shimRoot)
  const shims = await createPackageManagerShims(shimRoot)
  const projectRoot = join(base, "project's app")
  await mkdir(projectRoot)
  const env = { ...process.env, PATH: `${shimRoot}${process.platform === 'win32' ? ';' : ':'}${realBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
  return { shims, shimRoot, projectRoot, env, base }
}

function runManager(shimRoot: string, env: NodeJS.ProcessEnv, cwd: string, args: readonly string[]) {
  const launcher = renderLauncher('npm', process.platform).fileName
  return spawnSync(join(shimRoot, launcher), [...args], {
    cwd,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

describe('package manager shim', () => {
  it('forwards non-install commands to the real binary when paths contain apostrophes', async () => {
    const { shimRoot, projectRoot, env } = await createQuotedFixture()

    const result = runManager(shimRoot, env, projectRoot, ['--version'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('real npm: --version')
  })

  it.skipIf(process.platform === 'win32')('does not re-enter itself when PATH names the shim directory through a symlink', async () => {
    const { shimRoot, projectRoot, env, base } = await createQuotedFixture()
    const alias = join(base, 'alias')
    await symlink(shimRoot, alias)
    const aliasedEnv = { ...env, PATH: `${alias}:${env.PATH?.split(':').slice(1).join(':')}` }

    const result = runManager(shimRoot, aliasedEnv, projectRoot, ['--version'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('real npm: --version')
  })

  it('stops after the recursion depth limit instead of spawning again', async () => {
    const { shimRoot, projectRoot, env } = await createQuotedFixture()

    const result = runManager(shimRoot, { ...env, HOLO_PACKAGE_MANAGER_SHIM_DEPTH: '8' }, projectRoot, ['--version'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('re-entered itself')
  })

  it('records the install request and runs the install hook when paths contain apostrophes', async () => {
    const { shims, shimRoot, projectRoot, env } = await createQuotedFixture()
    await writeFile(join(projectRoot, 'install-hook.cjs'), "require('node:fs').writeFileSync('hook-ran.txt', 'ran')\n")

    const result = runManager(shimRoot, env, projectRoot, ['install'])

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(projectRoot, 'hook-ran.txt'), 'utf8')).toBe('ran')
    expect((await readFile(shims.installLog, 'utf8')).split('\n')).toContain(await realpath(projectRoot))
  })

  it('propagates a failing install hook exit status without recording a clean install', async () => {
    const { shims, shimRoot, projectRoot, env } = await createQuotedFixture()
    await writeFile(join(projectRoot, 'install-hook.cjs'), 'process.exit(3)\n')

    const result = runManager(shimRoot, env, projectRoot, ['install'])

    expect(result.status).toBe(3)
    expect((await readFile(shims.installLog, 'utf8')).split('\n')).toContain(await realpath(projectRoot))
  })
})

describe('package manager shim resolution', () => {
  it('resolves a Windows .cmd real binary through PATHEXT and skips the shim directory', () => {
    const files = new Set(['c:\\program files\\nodejs\\npm.cmd', 'c:\\shim\\npm.cmd'])

    const resolved = resolveExecutable('npm', 'C:\\shim;C:\\Program Files\\nodejs', {
      platform: 'win32',
      pathext: '.COM;.EXE;.BAT;.CMD',
      excludeDir: 'C:\\shim',
      isFile: (candidate: string) => files.has(candidate.toLowerCase()),
    })

    expect(resolved?.toLowerCase()).toBe('c:\\program files\\nodejs\\npm.cmd')
  })

  it('prefers the earlier PATHEXT extension within one directory on win32', () => {
    const files = new Set(['c:\\bun\\bun.exe', 'c:\\bun\\bun.cmd'])

    const resolved = resolveExecutable('bun', 'C:\\bun', {
      platform: 'win32',
      pathext: '.COM;.EXE;.BAT;.CMD',
      isFile: (candidate: string) => files.has(candidate.toLowerCase()),
    })

    expect(resolved?.toLowerCase()).toBe('c:\\bun\\bun.exe')
  })

  it('matches the shim directory case-insensitively on win32', () => {
    const files = new Set(['c:\\shim\\yarn.cmd', 'c:\\tools\\yarn.cmd'])

    const resolved = resolveExecutable('yarn', 'C:\\SHIM;C:\\tools', {
      platform: 'win32',
      pathext: '.CMD',
      excludeDir: 'c:\\shim',
      isFile: (candidate: string) => files.has(candidate.toLowerCase()),
    })

    expect(resolved?.toLowerCase()).toBe('c:\\tools\\yarn.cmd')
  })

  it('returns undefined when no PATHEXT variant exists on win32', () => {
    const resolved = resolveExecutable('pnpm', 'C:\\tools', {
      platform: 'win32',
      pathext: '.EXE;.CMD',
      isFile: () => false,
    })

    expect(resolved).toBeUndefined()
  })

  it('resolves POSIX binaries by name and skips the shim directory', () => {
    const files = new Set(['/shim/npm', '/usr/local/bin/npm'])

    const resolved = resolveExecutable('npm', '/shim:/usr/local/bin', {
      platform: 'linux',
      excludeDir: '/shim',
      isFile: (candidate: string) => files.has(candidate),
    })

    expect(resolved).toBe('/usr/local/bin/npm')
  })
})

describe('package manager launchers', () => {
  it('renders a .cmd launcher that forwards to the runner through the node path on win32', () => {
    const launcher = renderLauncher('npm', 'win32', 'C:\\node\\node.exe')

    expect(launcher.fileName).toBe('npm.cmd')
    expect(launcher.contents).toBe('@"C:\\node\\node.exe" "%~dp0shim.mjs" npm %*\r\n')
  })

  it('renders an executable sh launcher that execs node on POSIX', () => {
    const launcher = renderLauncher('npm', 'linux')

    expect(launcher.fileName).toBe('npm')
    expect(launcher.contents).toBe('#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" npm "$@"\n')
  })
})
