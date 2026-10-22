import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackageManagerShims } from '../../../tests/support/package-manager-shim'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function createQuotedFixture() {
  const base = await mkdtemp(join(tmpdir(), "holo-shim-it's-"))
  tempDirs.push(base)
  const realBin = join(base, "real bin's")
  await mkdir(realBin)
  await writeFile(join(realBin, 'npm'), '#!/bin/sh\necho "real npm: $*"\n', { mode: 0o755 })
  const shimRoot = join(base, "shim's root")
  await mkdir(shimRoot)
  const shims = await createPackageManagerShims(shimRoot, realBin)
  const projectRoot = join(base, "project's app")
  await mkdir(projectRoot)
  return { shims, shimRoot, projectRoot }
}

describe('package manager shim', () => {
  it('forwards non-install commands to the real binary when paths contain apostrophes', async () => {
    const { shimRoot } = await createQuotedFixture()

    const result = spawnSync(join(shimRoot, 'npm'), ['--version'], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('real npm: --version\n')
  })

  it('records the install request and runs the install hook when paths contain apostrophes', async () => {
    const { shims, shimRoot, projectRoot } = await createQuotedFixture()
    await writeFile(join(projectRoot, 'install-hook.cjs'), "require('node:fs').writeFileSync('hook-ran.txt', 'ran')\n")

    const result = spawnSync(join(shimRoot, 'npm'), ['install'], { cwd: projectRoot, encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(projectRoot, 'hook-ran.txt'), 'utf8')).toBe('ran')
    expect((await readFile(shims.installLog, 'utf8')).split('\n')).toContain(await realpath(projectRoot))
  })
})
