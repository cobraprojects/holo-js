import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const tempBuildRoots: string[] = []
let packageBuildPromise: Promise<{ outDir: string }> | null = null

async function createTempBuildRoot(): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, 'create-holo-js-'))
  tempBuildRoots.push(root)
  return root
}

async function runPackageBuild(): Promise<{ outDir: string }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot()
      const outDir = join(buildRoot, 'dist')

      execFileSync(resolve(packageDir, 'node_modules/.bin/tsup'), [], {
        cwd: packageDir,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

      await symlink(join(repoRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'dir')

      return { outDir }
    })()
  }

  return packageBuildPromise
}

afterAll(async () => {
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('create-holo-js bin', () => {
  it('emits and executes the published bin through the OS command path', async () => {
    const build = await runPackageBuild()
    const binPath = resolve(build.outDir, 'bin/create-holo-js.mjs')
    await chmod(binPath, 0o755)

    const output = execFileSync(binPath, ['--help'], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: 'pipe',
    })

    expect(output).toContain('holo new <name>')
    expect(output).toContain('Scaffold a new Holo project')

    const failure = spawnSync(binPath, ['native-invalid', '--framework', 'invalid'], {
      cwd: build.outDir,
      encoding: 'utf8',
    })
    expect(failure.error).toBeUndefined()
    expect(failure.status).toBe(1)
    expect(failure.stderr).toContain('framework')
  }, 60000)
})
