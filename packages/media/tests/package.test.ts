import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>
}

describe('@holo-js/media package scripts', () => {
  it('keeps the stub build non-interactive', () => {
    expect(packageJson.scripts?.stub).toBeDefined()
    expect(packageJson.scripts?.stub).not.toContain('--watch')
  })
})
