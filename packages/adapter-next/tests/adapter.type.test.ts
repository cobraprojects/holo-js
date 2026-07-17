import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithBufferEncoding } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNextHoloHelpers } from '../src'
import {
  linkInstalledDependenciesForPackage,
  stagePublishedPackage,
} from '../../../tests/support/published-package'

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

function expectCommandToPass(command: string, args: readonly string[], options: ExecFileSyncOptionsWithBufferEncoding): void {
  try {
    execFileSync(command, args, options)
  } catch (error) {
    const failure = error as {
      readonly stderr?: Buffer
      readonly stdout?: Buffer
    }
    throw new Error([
      failure.stdout?.toString(),
      failure.stderr?.toString(),
    ].filter(Boolean).join('\n'))
  }
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
      await linkInstalledDependenciesForPackage({
        repoRoot: resolve(packageDir, '../..'),
        nodeModulesRoot: tempNodeModules,
        packageJsonPath: resolve(packageDir, '../validation/package.json'),
        extraDependencyNames: ['@types/node', '@types/react', 'react'],
      })

      buildPackage(resolve(packageDir, '../config'), join(buildRoot, 'config'))
      buildPackage(resolve(packageDir, '../validation'), join(buildRoot, 'validation'))
      buildPackage(resolve(packageDir, '../forms'), join(buildRoot, 'forms'))
      buildPackage(resolve(packageDir, '../auth'), join(buildRoot, 'auth'))
      buildPackage(packageDir)

      for (const [sourceDir, targetDir, distDir] of [
        [resolve(packageDir, '../config'), join(tempHoloNodeModules, 'config'), join(buildRoot, 'config')],
        [resolve(packageDir, '../validation'), join(tempHoloNodeModules, 'validation'), join(buildRoot, 'validation')],
        [resolve(packageDir, '../forms'), join(tempHoloNodeModules, 'forms'), join(buildRoot, 'forms')],
        [resolve(packageDir, '../auth'), join(tempHoloNodeModules, 'auth'), join(buildRoot, 'auth')],
        [packageDir, join(tempHoloNodeModules, 'adapter-next'), join(packageDir, 'dist')],
      ] as const) {
        await stagePublishedPackage(sourceDir, targetDir, distDir)
      }

      await writeFile(
        entryPath,
        [
          `import { AuthProvider, useAuth, type HoloAuthUser, type UseAuthResult } from '@holo-js/auth/next/client'`,
          `import { auth } from '@holo-js/auth/next/server'`,
          `import { field, schema } from '@holo-js/forms'`,
          `import { useForm } from '@holo-js/adapter-next/client'`,
          `const loginForm = schema({ email: field.string().required().email() })`,
          `useForm(loginForm, {`,
          `  initialValues: { email: '' },`,
          `  async submitter({ formData, values }) {`,
          `    const email: string = values.email`,
          `    const submittedEmail = formData.get('email')`,
          `    void submittedEmail`,
          `    return { ok: true, status: 200, data: { email } }`,
          `  },`,
          `})`,
          `const currentAuth = useAuth()`,
          `const user: HoloAuthUser | null = currentAuth.user`,
          `const authResult: UseAuthResult = currentAuth`,
          `void AuthProvider`,
          `void user`,
          `void authResult`,
          `void useForm`,
          `void auth`,
          ``,
        ].join('\n'),
      )

      expectCommandToPass(
        resolve(packageDir, '../../node_modules/.bin/tsc'),
        [
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2022',
          '--strict',
          '--noEmit',
          entryPath,
        ],
        {
          cwd: tempDir,
          stdio: 'pipe',
        },
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60000)
})
