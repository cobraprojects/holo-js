import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('..', import.meta.url))

describe('package checks', () => {
  it('include the executable Next config in lint and typecheck coverage', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.scripts.lint).toContain('next.config.ts')

    const listedFiles = execFileSync('bun', ['x', 'tsc', '-p', 'tsconfig.json', '--noEmit', '--listFilesOnly'], {
      cwd: appRoot,
      encoding: 'utf8',
    })
    const normalizedNextConfigPath = join(appRoot, 'next.config.ts')

    expect(listedFiles.split(/\r?\n/)).toContain(normalizedNextConfigPath)
  })
})
