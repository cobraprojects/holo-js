import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const tempBuildRoots: string[] = []
let packageBuildPromise: Promise<{ outDir: string }> | null = null

async function createTempBuildRoot(prefix: string): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, `${prefix}-`))
  tempBuildRoots.push(root)
  return root
}

async function runPackageBuild(): Promise<{ outDir: string }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const packageRoot = await createTempBuildRoot('storage')
      const outDir = join(packageRoot, 'dist')

      execFileSync('bun', ['run', 'build'], {
        cwd: packageDir,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

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

describe('@holo-js/storage runtime packaging', () => {
  it('emits the exported runtime entrypoints in stub builds', async () => {
    const build = await runPackageBuild()

    expect(existsSync(resolve(build.outDir, 'runtime/composables/index.mjs'))).toBe(true)
    expect(existsSync(resolve(build.outDir, 'runtime/composables/index.d.ts'))).toBe(true)
  }, 60000)

  it('publishes a runtime declaration that type-checks under NodeNext resolution', async () => {
    const build = await runPackageBuild()

    const tempDir = await mkdtemp(join(tmpdir(), 'holo-storage-types-'))
    const entryPath = join(tempDir, 'runtime-import.ts')

    try {
      await writeFile(
        entryPath,
        `import { Storage } from ${JSON.stringify(resolve(build.outDir, 'runtime/composables/index.mjs'))}\nvoid Storage\n`,
      )

      expect(() => execFileSync(
        resolve(repoRoot, 'node_modules/.bin/tsc'),
        [
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2022',
          '--noEmit',
          entryPath,
        ],
        {
          cwd: repoRoot,
          stdio: 'pipe',
        },
      )).not.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60000)

  it('imports the published runtime entry in plain Node without requiring Nuxt aliases', async () => {
    const build = await runPackageBuild()

    const runtimeEntry = resolve(build.outDir, 'runtime/composables/index.mjs')
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `const runtime = await import(${JSON.stringify(runtimeEntry)});`
        + `console.log(typeof runtime.Storage.disk);`
        + `try { runtime.Storage.path('example.txt') } catch (error) { console.log(error instanceof Error ? error.message : String(error)) }`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    )

    expect(output).toContain('function')
    expect(output).toContain('Storage runtime is not configured')
  }, 60000)
})
