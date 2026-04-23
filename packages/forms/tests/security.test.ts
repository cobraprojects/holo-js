import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FormContractError } from '../src'
import { getClientCsrfField, clientSecurityInternals, loadSecurityClientModule } from '../src/client-security'
import { formsSecurityInternals, loadSecurityModule } from '../src/security'

const formsSourceRoot = resolve(import.meta.dirname, '..')
const formsFixtureFiles = [
  'src/client-security.ts',
  'src/contracts.ts',
  'src/security.ts',
] as const
const tempDirs: string[] = []

async function runBun(
  args: string[],
  options: ExecFileOptionsWithStringEncoding = {},
): Promise<{ stdout: string, stderr: string } | undefined> {
  try {
    return await new Promise<{ stdout: string, stderr: string }>((resolvePromise, rejectPromise) => {
      execFile('bun', args, {
        encoding: 'utf8',
        timeout: 30_000,
        ...options,
      }, (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error)
          return
        }

        resolvePromise({ stdout, stderr })
      })
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityImport__?: unknown }).__holoFormsSecurityImport__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityClientImport__?: unknown }).__holoFormsSecurityClientImport__
  delete (globalThis as typeof globalThis & { document?: Document }).document
  formsSecurityInternals.resetSecurityModuleCache()
  clientSecurityInternals.resetSecurityClientModuleCache()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createSecurityFixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-forms-security-fixture-'))
  tempDirs.push(root)

  for (const relativePath of formsFixtureFiles) {
    const source = resolve(formsSourceRoot, relativePath)
    const target = resolve(root, relativePath)
    await mkdir(resolve(target, '..'), { recursive: true })
    await copyFile(source, target)
  }

  const tsconfig = {
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@holo-js/validation': [resolve(import.meta.dirname, '../../validation/src/index.ts')],
      },
    },
  }
  await writeFile(resolve(root, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8')

  return root
}

async function writeSecurityPackage(projectRoot: string, files: Record<string, string>): Promise<void> {
  const securityPackageRoot = join(projectRoot, 'node_modules', '@holo-js', 'security')

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(securityPackageRoot, relativePath)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, contents, { encoding: 'utf8', flag: 'w' })
  }
}

describe('@holo-js/forms security helpers', () => {
  it('avoids opting the security client import out of browser bundling', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/client-security.ts'), 'utf8')

    expect(source).not.toContain('webpackIgnore')
  })

  it('keeps the security client import visible to browser bundlers', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'holo-forms-security-bundle-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'holo-forms-security-project-'))

    try {
      const tsconfig = {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@holo-js/validation': [resolve(import.meta.dirname, '../../validation/src/index.ts')],
            '@holo-js/security': [resolve(import.meta.dirname, '../../security/src/index.ts')],
            '@holo-js/security/client': [resolve(import.meta.dirname, '../../security/src/client.ts')],
            '@holo-js/config': [resolve(import.meta.dirname, '../../config/src/index.ts')],
          },
        },
      }

      await writeFile(join(projectDir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8')

      const result = await runBun([
        'build',
        resolve(import.meta.dirname, '../src/client-security.ts'),
        '--target=browser',
        '--format=esm',
        '--splitting',
        '--external=@holo-js/security/client',
        `--outdir=${outdir}`,
      ], {
        cwd: projectDir,
      })
      if (!result) {
        return
      }

      const output = await readFile(join(outdir, 'client-security.js'), 'utf8')

      expect(output).toContain('import("@holo-js/security/client")')
      expect(output).not.toContain('const specifier = ["@holo-js", "security", "client"].join("/")')
    } finally {
      await rm(outdir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('loads the optional security entrypoints through literal imports during Vitest', async () => {
    vi.resetModules()
    vi.doMock('@holo-js/security', () => ({
      csrf: {
        async verify() {},
      },
      async rateLimit() {
        return { limited: false }
      },
    }))
    vi.doMock('@holo-js/security/client', () => ({
      getSecurityClientConfig() {
        return {
          csrf: {
            field: '_token',
            cookie: 'XSRF-TOKEN',
          },
        }
      },
    }))

    try {
      const mod = await import('../src/client-security')

      await expect(mod.loadSecurityClientModule()).resolves.toMatchObject({
        getSecurityClientConfig: expect.any(Function),
      })
    } finally {
      vi.doUnmock('@holo-js/security')
      vi.doUnmock('@holo-js/security/client')
      vi.resetModules()
    }
  })

  it('loads the server security entrypoint through the Vitest literal import branch', async () => {
    vi.resetModules()
    vi.doMock('@holo-js/security', () => ({
      csrf: {
        async verify() {},
      },
      async rateLimit() {
        return { limited: false }
      },
    }))

    try {
      const mod = await import('../src/security')

      await expect(mod.loadSecurityModule()).resolves.toMatchObject({
        csrf: {
          verify: expect.any(Function),
        },
        rateLimit: expect.any(Function),
      })
    } finally {
      vi.doUnmock('@holo-js/security')
      vi.resetModules()
    }
  })

  it('loads the optional security entrypoints through literal imports outside the Vitest branch', async () => {
    const originalVitest = process.env.VITEST

    vi.resetModules()
    vi.doMock('@holo-js/security', () => ({
      csrf: {
        async verify() {},
      },
      async rateLimit() {
        return { limited: false }
      },
    }))
    vi.doMock('@holo-js/security/client', () => ({
      getSecurityClientConfig() {
        return {
          csrf: {
            field: '_token',
            cookie: 'XSRF-TOKEN',
          },
        }
      },
    }))

    if (typeof originalVitest === 'undefined') {
      delete process.env.VITEST
    } else {
      process.env.VITEST = ''
    }

    try {
      const mod = await import('../src/client-security')

      await expect(mod.loadSecurityClientModule()).resolves.toMatchObject({
        getSecurityClientConfig: expect.any(Function),
      })
    } finally {
      vi.doUnmock('@holo-js/security')
      vi.doUnmock('@holo-js/security/client')
      vi.resetModules()
      if (typeof originalVitest === 'undefined') {
        delete process.env.VITEST
      } else {
        process.env.VITEST = originalVitest
      }
    }
  })

  it('loads the optional security entrypoints without bundler escape hatches outside Vitest', async () => {
    const projectRoot = await createSecurityFixtureProject()

    await writeSecurityPackage(projectRoot, {
      'package.json': JSON.stringify({
        name: '@holo-js/security',
        type: 'module',
        exports: {
          '.': './index.js',
          './client': './client.js',
        },
      }, null, 2),
      'index.js': `
export const csrf = {
  async verify() {},
}

export async function rateLimit() {
  return { limited: false }
}
`,
      'client.js': `
export function getSecurityClientConfig() {
  return {
    csrf: {
      field: '_token',
      cookie: 'XSRF-TOKEN',
    },
  }
}
`,
    })

    const result = await runBun([
      '--eval',
      `
const securityMod = await import(${JSON.stringify(resolve(projectRoot, 'src/security.ts'))})
const clientMod = await import(${JSON.stringify(resolve(projectRoot, 'src/client-security.ts'))})
const security = await securityMod.loadSecurityModule()
const client = await clientMod.loadSecurityClientModule()

console.log(JSON.stringify({
  hasVerify: typeof security.csrf?.verify === 'function',
  hasRateLimit: typeof security.rateLimit === 'function',
  hasClientConfig: typeof client.getSecurityClientConfig === 'function',
}))
      `,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        VITEST: '',
      },
    })
    if (!result) {
      return
    }

    expect(JSON.parse(result.stdout)).toEqual({
      hasVerify: true,
      hasRateLimit: true,
      hasClientConfig: true,
    })
  })

  it('loads the optional security module when process is unavailable', async () => {
    vi.resetModules()
    vi.doMock('@holo-js/security', () => ({
      csrf: {
        async verify() {},
      },
      async rateLimit() {
        return { limited: false }
      },
    }))
    vi.stubGlobal('process', undefined)

    try {
      await expect(loadSecurityModule()).resolves.toMatchObject({
        csrf: {
          verify: expect.any(Function),
        },
        rateLimit: expect.any(Function),
      })
    } finally {
      vi.doUnmock('@holo-js/security')
      vi.resetModules()
      vi.unstubAllGlobals()
      formsSecurityInternals.resetSecurityModuleCache()
    }
  })

  it('parses cookie headers and recognizes optional-package errors', () => {
    expect(formsSecurityInternals.parseCookieHeader('XSRF-TOKEN=one; broken; csrf-token=two')).toEqual({
      'XSRF-TOKEN': 'one',
      'csrf-token': 'two',
    })
    expect(formsSecurityInternals.parseCookieHeader('tracking=%; XSRF-TOKEN=one')).toEqual({
      'XSRF-TOKEN': 'one',
    })
    expect(formsSecurityInternals.isMissingOptionalPackageError('boom')).toBe(false)
    expect(formsSecurityInternals.isMissingOptionalPackageError(new Error('Cannot find package @holo-js/security'))).toBe(true)
    expect(formsSecurityInternals.isMissingOptionalPackageError(new Error('Could not resolve "@holo-js/security"'))).toBe(true)
    expect(
      formsSecurityInternals.isMissingOptionalPackageError(
        new Error('Cannot find module "sharp" imported from "@holo-js/security".'),
      ),
    ).toBe(false)
    expect(formsSecurityInternals.isMissingOptionalPackageError(new Error('boom'))).toBe(false)
    expect(formsSecurityInternals.isRootSecurityError(Object.assign(new Error('CSRF token mismatch.'), { status: 419 }))).toBe(true)
    expect(formsSecurityInternals.isRootSecurityError(Object.assign(new Error('nope'), { status: 500 }))).toBe(false)
  })

  it('reads the csrf token cookie even when unrelated cookies are malformed', async () => {
    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__ = {
      getSecurityClientConfig() {
        return {
          csrf: {
            field: '_token',
            cookie: 'XSRF-TOKEN',
          },
        }
      },
    }

    ;(globalThis as typeof globalThis & { document?: Document }).document = {
      cookie: 'tracking=%; XSRF-TOKEN=client-token',
    } as Document

    await expect(getClientCsrfField()).resolves.toEqual({
      name: '_token',
      value: 'client-token',
    })
  })

  it('fails clearly when csrf helpers run without a browser document or a test override', async () => {
    ;(globalThis as typeof globalThis & { __holoFormsSecurityImport__?: () => Promise<unknown> }).__holoFormsSecurityImport__ = async () => {
      throw new Error('Cannot find package @holo-js/security')
    }
    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientImport__?: () => Promise<unknown> }).__holoFormsSecurityClientImport__ = async () => {
      throw new Error('Cannot find package @holo-js/security')
    }

    await expect(getClientCsrfField()).rejects.toBeInstanceOf(FormContractError)
    await expect(loadSecurityModule()).rejects.toBeInstanceOf(FormContractError)
    await expect(loadSecurityClientModule()).rejects.toBeInstanceOf(FormContractError)
  })

  it('rethrows unexpected module load failures for both security entrypoints', async () => {
    ;(globalThis as typeof globalThis & { __holoFormsSecurityImport__?: () => Promise<unknown> }).__holoFormsSecurityImport__ = async () => {
      throw new Error('server security exploded')
    }

    await expect(loadSecurityModule()).rejects.toThrow('server security exploded')

    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientImport__?: () => Promise<unknown> }).__holoFormsSecurityClientImport__ = async () => {
      throw 'client security exploded'
    }
    await expect(loadSecurityClientModule()).rejects.toBe('client security exploded')
  })
})
