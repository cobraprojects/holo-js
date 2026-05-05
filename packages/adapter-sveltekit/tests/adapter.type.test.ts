import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SerializedSvelteKitData } from '../src/transport'
import {
  linkInstalledDependenciesForPackage,
  stagePublishedPackage,
} from '../../../tests/support/published-package'

const packageDir = resolve(import.meta.dirname, '..')

function buildPackage(packageRoot: string, outDir: string): void {
  execFileSync(resolve(packageRoot, 'node_modules/.bin/tsup'), [], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOLO_BUILD_OUT_DIR: outDir,
    },
    stdio: 'pipe',
  })
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

afterEach(() => {
  vi.resetModules()
})

describe('@holo-js/adapter-sveltekit typing', () => {
  it('preserves inference for helper accessors', async () => {
    const { createSvelteKitHoloHelpers } = await import('../src')
    const helpers = createSvelteKitHoloHelpers()

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

  it('preserves serialized payload inference for transport serialization', async () => {
    const model = {
      id: 1,
      name: 'Amina',
      toJSON() {
        return {
          id: this.id,
          name: this.name,
        }
      },
    }

    type LoadResult = SerializedSvelteKitData<{
      user: typeof model
      users: typeof model[]
    }>
    type SerializedValue = SerializedSvelteKitData<typeof model>
    type UserResult = LoadResult extends { user: infer TResult } ? TResult : never
    type UsersResult = LoadResult extends { users: readonly (infer TResult)[] } ? TResult : never

    const userResult: UserResult = {
      id: 1,
      name: 'Amina',
    }
    const usersResult: UsersResult = {
      id: 1,
      name: 'Amina',
    }
    const serializedValue: SerializedValue = {
      id: 1,
      name: 'Amina',
    }

    void userResult
    void usersResult
    void serializedValue
  })

  it('publishes a client declaration that type-checks under NodeNext resolution', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'holo-sveltekit-client-types-'))
    const tempNodeModules = join(tempDir, 'node_modules')
    const tempHoloNodeModules = join(tempNodeModules, '@holo-js')
    const buildRoot = join(tempDir, 'build')
    const entryPath = join(tempDir, 'client-import.ts')

    try {
      await mkdir(tempHoloNodeModules, { recursive: true })
      await linkInstalledDependenciesForPackage({
        repoRoot: resolve(packageDir, '../..'),
        nodeModulesRoot: tempNodeModules,
        packageJsonPath: resolve(packageDir, '../validation/package.json'),
      })

      buildPackage(resolve(packageDir, '../validation'), join(buildRoot, 'validation'))
      buildPackage(resolve(packageDir, '../forms'), join(buildRoot, 'forms'))
      buildPackage(packageDir, join(buildRoot, 'adapter-sveltekit'))

      await Promise.all([
        stagePublishedPackage(resolve(packageDir, '../validation'), join(tempHoloNodeModules, 'validation'), join(buildRoot, 'validation')),
        stagePublishedPackage(resolve(packageDir, '../forms'), join(tempHoloNodeModules, 'forms'), join(buildRoot, 'forms')),
        stagePublishedPackage(packageDir, join(tempHoloNodeModules, 'adapter-sveltekit'), join(buildRoot, 'adapter-sveltekit')),
      ])

      await writeFile(
        entryPath,
        `import { useForm } from '@holo-js/adapter-sveltekit/client'\nvoid useForm\n`,
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
