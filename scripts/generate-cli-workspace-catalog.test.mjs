import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { generateCliWorkspaceCatalog } from './generate-cli-workspace-catalog.mjs'

let repoRoot

after(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true })
  }
})

test('workspace catalog generator creates the generated directory', async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'holo-workspace-catalog-'))
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({
    workspaces: {
      catalog: {
        eslint: '^9.0.0',
      },
    },
  }, null, 2), 'utf8')

  await generateCliWorkspaceCatalog(repoRoot)

  const output = await readFile(
    join(repoRoot, 'packages/cli/src/generated/workspaceCatalog.ts'),
    'utf8',
  )
  assert.match(output, /"eslint"\s*:/)
})
