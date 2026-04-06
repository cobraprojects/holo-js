import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

async function provisionTempPackage(sourcePackageDir: string, tempPackageDir: string): Promise<void> {
  await cp(sourcePackageDir, tempPackageDir, {
    recursive: true,
    filter(source) {
      return !source.includes('/dist/')
        && !source.endsWith('/dist')
        && !source.includes('/tests/')
        && !source.endsWith('/tests')
        && !source.includes('/node_modules/')
        && !source.endsWith('/node_modules')
    },
  })
}

async function runPackageBuild(): Promise<{ outDir: string }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot('queue-db')
      const dbPackageRoot = join(buildRoot, 'packages/db')
      const queuePackageRoot = join(buildRoot, 'packages/queue')
      const queueDbPackageRoot = join(buildRoot, 'packages/queue-db')
      const outDir = join(queueDbPackageRoot, 'dist')
      const nodeModulesRoot = join(buildRoot, 'node_modules')
      const typesRoot = join(nodeModulesRoot, '@types')
      const holoNodeModulesRoot = join(nodeModulesRoot, '@holo-js')

      await symlink(resolve(repoRoot, 'tsconfig.json'), join(buildRoot, 'tsconfig.json'))
      await mkdir(nodeModulesRoot, { recursive: true })
      await mkdir(typesRoot, { recursive: true })
      await mkdir(holoNodeModulesRoot, { recursive: true })
      await symlink(resolve(packageDir, '../db/node_modules/tsup'), join(nodeModulesRoot, 'tsup'))
      await symlink(resolve(packageDir, '../db/node_modules/typescript'), join(nodeModulesRoot, 'typescript'))
      await symlink(resolve(repoRoot, 'node_modules/@types/node'), join(typesRoot, 'node'))
      await symlink(resolve(repoRoot, 'node_modules/@types/better-sqlite3'), join(typesRoot, 'better-sqlite3'))
      await symlink(resolve(packageDir, '../db/node_modules/@types/pg'), join(typesRoot, 'pg'))
      await provisionTempPackage(resolve(repoRoot, 'packages/db'), dbPackageRoot)
      await provisionTempPackage(resolve(repoRoot, 'packages/queue'), queuePackageRoot)
      await provisionTempPackage(packageDir, queueDbPackageRoot)
      await symlink(dbPackageRoot, join(holoNodeModulesRoot, 'db'))
      await symlink(queuePackageRoot, join(holoNodeModulesRoot, 'queue'))
      await symlink(resolve(repoRoot, 'node_modules/.bun/node_modules/bullmq'), join(nodeModulesRoot, 'bullmq'))

      execFileSync(resolve(packageDir, '../db/node_modules/.bin/tsup'), [], {
        cwd: dbPackageRoot,
        env: {
          ...process.env,
        },
        stdio: 'pipe',
      })

      execFileSync(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], {
        cwd: queuePackageRoot,
        env: {
          ...process.env,
        },
        stdio: 'pipe',
      })

      execFileSync(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], {
        cwd: queueDbPackageRoot,
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

describe('@holo-js/queue-db packaging', () => {
  it('emits the published package entrypoints in stub builds', async () => {
    const build = await runPackageBuild()

    expect(existsSync(resolve(build.outDir, 'index.mjs'))).toBe(true)
    expect(existsSync(resolve(build.outDir, 'index.d.ts'))).toBe(true)
  }, 60000)

  it('publishes declarations that type-check under NodeNext resolution', async () => {
    const build = await runPackageBuild()

    const tempDir = await mkdtemp(join(tmpdir(), 'holo-queue-db-types-'))
    const entryPath = join(tempDir, 'queue-db-import.ts')

    try {
      await writeFile(
        entryPath,
        `import { createQueueDbRuntimeOptions } from ${JSON.stringify(resolve(build.outDir, 'index.mjs'))}\n`
        + 'void createQueueDbRuntimeOptions\n',
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

  it('imports the published package entry in plain Node', async () => {
    const build = await runPackageBuild()

    const runtimeEntry = resolve(build.outDir, 'index.mjs')
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `const runtime = await import(${JSON.stringify(runtimeEntry)});`
        + 'console.log(typeof runtime.createQueueDbRuntimeOptions);'
        + 'console.log(runtime.createQueueDbRuntimeOptions().driverFactories[0].driver);',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    )

    expect(output).toContain('function')
    expect(output).toContain('database')
  }, 60000)
})
