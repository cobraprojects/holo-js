import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { FormContractError } from '../src'
import { formsSecurityInternals, getClientCsrfField, loadSecurityClientModule, loadSecurityModule } from '../src/security'

const execFileAsync = promisify(execFile)
const formsNodeModulesRoot = resolve(import.meta.dirname, '../node_modules')
const securityPackageRoot = join(formsNodeModulesRoot, '@holo-js/security')

afterEach(() => {
  delete (globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityImport__?: unknown }).__holoFormsSecurityImport__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityClientImport__?: unknown }).__holoFormsSecurityClientImport__
  delete (globalThis as typeof globalThis & { document?: Document }).document
  formsSecurityInternals.resetSecurityModuleCache()
})

afterEach(async () => {
  await rm(formsNodeModulesRoot, { recursive: true, force: true })
})

async function writeSecurityPackage(files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(securityPackageRoot, relativePath)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, contents, { encoding: 'utf8', flag: 'w' })
  }
}

describe('@holo-js/forms security helpers', () => {
  it('keeps the security client import visible to browser bundlers', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'holo-forms-security-bundle-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'holo-forms-security-project-'))

    try {
      await writeFile(join(projectDir, 'tsconfig.json'), `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@holo-js/validation": ["${resolve(import.meta.dirname, '../../validation/src/index.ts')}"],
      "@holo-js/security": ["${resolve(import.meta.dirname, '../../security/src/index.ts')}"],
      "@holo-js/security/client": ["${resolve(import.meta.dirname, '../../security/src/client.ts')}"],
      "@holo-js/config": ["${resolve(import.meta.dirname, '../../config/src/index.ts')}"]
    }
  }
}
`, 'utf8')

      await execFileAsync('bun', [
        'build',
        resolve(import.meta.dirname, '../src/security.ts'),
        '--target=browser',
        '--format=esm',
        '--splitting',
        '--external=@holo-js/validation',
        '--external=@holo-js/security',
        '--external=@holo-js/security/client',
        `--outdir=${outdir}`,
      ], {
        cwd: projectDir,
      })

      const output = await readFile(join(outdir, 'security.js'), 'utf8')

      expect(output).toContain('import("@holo-js/security/client")')
    } finally {
      await rm(outdir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
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

    globalThis.document = {
      cookie: 'tracking=%; XSRF-TOKEN=client-token',
    } as Document

    await expect(getClientCsrfField()).resolves.toEqual({
      name: '_token',
      value: 'client-token',
    })
  })

  it('fails clearly when csrf helpers run without a browser document or a test override', async () => {
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
