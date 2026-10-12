import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HOLO_PACKAGE_VERSION } from '../src/metadata'

type CliBinName = 'holo' | 'holo-js'

type CliBinEntries = Record<CliBinName, string>

type PackageManifest = {
  bin?: Partial<Record<CliBinName, string>>
}

const packageDir = resolve(import.meta.dirname, '..')
const tempBuildRoots: string[] = []
let packageBuildPromise: Promise<{ packageRoot: string, binEntries: CliBinEntries }> | null = null

async function createTempBuildRoot(): Promise<string> {
  const baseDir = resolve(packageDir, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, 'cli-bin-'))
  tempBuildRoots.push(root)
  return root
}

function readCliBinEntries(manifest: PackageManifest): CliBinEntries {
  const holoBin = manifest.bin?.holo
  const holoJsBin = manifest.bin?.['holo-js']

  if (typeof holoBin !== 'string' || typeof holoJsBin !== 'string') {
    throw new Error('@holo-js/cli package.json must declare holo and holo-js bin entries.')
  }

  return {
    holo: holoBin,
    'holo-js': holoJsBin,
  }
}

async function runPackageBuild(): Promise<{ packageRoot: string, binEntries: CliBinEntries }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot()
      const packageRoot = join(buildRoot, 'package')
      const outDir = join(packageRoot, 'dist')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), await readFile(join(packageDir, 'package.json'), 'utf8'))

      execFileSync('bun', ['run', 'build'], {
        cwd: packageDir,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

      await symlink(resolve(packageDir, '../../node_modules'), join(packageRoot, 'node_modules'), 'dir')

      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest

      return {
        packageRoot,
        binEntries: readCliBinEntries(manifest),
      }
    })()
  }

  return packageBuildPromise
}

afterAll(async () => {
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('holo bin', () => {
  it('emits and executes both published bin aliases from package.json', async () => {
    const { packageRoot, binEntries } = await runPackageBuild()
    const binariesDir = join(packageRoot, 'bin')
    await mkdir(binariesDir, { recursive: true })

    for (const binName of ['holo', 'holo-js'] as const) {
      const binPath = resolve(packageRoot, binEntries[binName])
      const linkedBinPath = join(binariesDir, binName)
      await chmod(binPath, 0o755)
      await rm(linkedBinPath, { force: true })
      await symlink(binPath, linkedBinPath)

      const output = execFileSync(linkedBinPath, ['--help'], {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })

      expect(output).toContain('Internal commands:')
      expect(output).toContain('  list')

      const version = execFileSync(linkedBinPath, ['--version'], {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })

      expect(version).toBe(`${HOLO_PACKAGE_VERSION}\n`)

      const failure = spawnSync(linkedBinPath, ['unknown-native-command'], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
      expect(failure.error).toBeUndefined()
      expect(failure.status).toBe(1)
      expect(failure.stderr).toContain('Unknown command "unknown-native-command".')
    }
  }, 60000)
})
