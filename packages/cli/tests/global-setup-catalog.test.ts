import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { generateCliWorkspaceCatalog } from '../../../scripts/generate-cli-workspace-catalog.mjs'
import { writeWorkspaceBuildMarker, isWorkspaceBuildCurrent } from '../../../scripts/workspace-build-fingerprint.mjs'
import { prepareWorkspaceDists } from './global-setup'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function writeRootCatalog(root: string, version: string): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'root',
    workspaces: { catalog: { '@holo-js/cli': version } },
  }))
}

async function createRepository(version: string): Promise<{ root: string, cli: string }> {
  const root = await mkdtemp(join(tmpdir(), 'holo-global-setup-catalog-'))
  roots.push(root)
  const cli = join(root, 'packages', 'cli')
  await mkdir(join(cli, 'src'), { recursive: true })
  await writeRootCatalog(root, version)
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  await writeFile(join(root, 'bun.lock'), 'lock\n')
  await writeFile(join(cli, 'package.json'), JSON.stringify({
    name: '@holo-js/cli',
    main: './dist/index.mjs',
    scripts: { build: 'tsup' },
  }))
  await writeFile(join(cli, 'src', 'index.ts'), 'export {}\n')
  return { root, cli }
}

async function bundleCatalog(_name: string, root: string): Promise<void> {
  const cli = join(root, 'packages', 'cli')
  const catalog = await readFile(join(cli, 'src', 'generated', 'workspaceCatalog.ts'), 'utf8')
  await mkdir(join(cli, 'dist'), { recursive: true })
  await writeFile(join(cli, 'dist', 'index.mjs'), catalog)
}

it('rebuilds the CLI from a regenerated catalog after a root catalog change', async () => {
  const { root, cli } = await createRepository('1.0.0')
  await generateCliWorkspaceCatalog(root)
  await bundleCatalog('@holo-js/cli', root)
  writeWorkspaceBuildMarker(cli, root)

  await writeRootCatalog(root, '2.0.0')
  const rebuilt = await prepareWorkspaceDists(root, bundleCatalog)

  expect(rebuilt).toEqual(['@holo-js/cli'])
  expect(await readFile(join(cli, 'src', 'generated', 'workspaceCatalog.ts'), 'utf8')).toContain('2.0.0')
  expect(await readFile(join(cli, 'dist', 'index.mjs'), 'utf8')).toContain('2.0.0')
  expect(isWorkspaceBuildCurrent(cli, root)).toBe(true)
}, 60_000)
