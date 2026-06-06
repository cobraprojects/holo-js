import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/realtime docs', () => {
  it('documents the post-scaffold install command with npx', async () => {
    const root = resolve(import.meta.dirname, '../../..')
    const installation = await readFile(resolve(root, 'apps/docs/docs/installation.md'), 'utf8')

    expect(installation).toContain('npx holo install realtime')
  })
})
