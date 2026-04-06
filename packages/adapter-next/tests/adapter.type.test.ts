import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNextHoloHelpers } from '../src'

const packageDir = resolve(import.meta.dirname, '..')

function buildPackage(packageRoot: string, outDir?: string): void {
  execFileSync(resolve(packageRoot, 'node_modules/.bin/tsup'), [], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...(outDir ? { HOLO_BUILD_OUT_DIR: outDir } : {}),
    },
    stdio: 'pipe',
  })
}

async function stagePublishedPackage(sourceDir: string, targetDir: string, distDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'package.json'), await readFile(join(sourceDir, 'package.json'), 'utf8'))
  await cp(distDir, join(targetDir, 'dist'), { recursive: true })
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    services: {
      mailgun: {
        secret: string
      }
    }
  }
}

describe('@holo-js/adapter-next typing', () => {
  it('preserves inference for helper accessors', () => {
    const helpers = createNextHoloHelpers()

    type Helpers = typeof helpers
    type ServicesResult = Helpers extends {
      useConfig: (key: 'services') => Promise<infer TResult>
    }
      ? TResult
      : never
    type SecretResult = Helpers extends {
      config: (path: 'services.mailgun.secret') => Promise<infer TResult>
    }
      ? TResult
      : never

    const services: ServicesResult = {
      mailgun: {
        secret: 'secret',
      },
    }
    const secret: SecretResult = 'secret'

    void services
    void secret
  })

  it('publishes a client declaration that type-checks under NodeNext resolution', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'holo-next-client-types-'))
    const tempNodeModules = join(tempDir, 'node_modules')
    const tempHoloNodeModules = join(tempNodeModules, '@holo-js')
    const buildRoot = join(tempDir, 'build')
    const entryPath = join(tempDir, 'client-import.ts')

    try {
      await mkdir(tempHoloNodeModules, { recursive: true })
      await symlink(resolve(packageDir, '../validation/node_modules/valibot'), join(tempNodeModules, 'valibot'))

      buildPackage(resolve(packageDir, '../validation'), join(buildRoot, 'validation'))
      buildPackage(resolve(packageDir, '../forms'), join(buildRoot, 'forms'))
      buildPackage(packageDir)

      await Promise.all([
        stagePublishedPackage(resolve(packageDir, '../validation'), join(tempHoloNodeModules, 'validation'), join(buildRoot, 'validation')),
        stagePublishedPackage(resolve(packageDir, '../forms'), join(tempHoloNodeModules, 'forms'), join(buildRoot, 'forms')),
        stagePublishedPackage(packageDir, join(tempHoloNodeModules, 'adapter-next'), join(packageDir, 'dist')),
      ])

      await writeFile(
        entryPath,
        `import { useForm } from '@holo-js/adapter-next/client'\nvoid useForm\n`,
      )

      expect(() => execFileSync(
        resolve(packageDir, '../../node_modules/.bin/tsc'),
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
          cwd: tempDir,
          stdio: 'pipe',
        },
      )).not.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60000)
})
