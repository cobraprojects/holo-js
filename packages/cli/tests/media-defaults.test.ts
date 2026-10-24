import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import '@holo-js/media/config'
import { minVersion } from 'semver'
import { afterEach, expect, it } from 'vitest'
import { runProjectPrepare } from '../src/dev'
import { WORKSPACE_CATALOG } from '../src/generated/workspaceCatalog'

const catalogMediaRange = WORKSPACE_CATALOG['@holo-js/media']
const catalogMediaVersion = minVersion(catalogMediaRange)!
// A range the current release satisfies, written differently from the catalog range so preservation is observable.
const compatibleMediaRange = `~${catalogMediaVersion.major}.${catalogMediaVersion.minor}.0`
// A range from the previous release line, which the current release doesn't satisfy.
const olderMediaRange = catalogMediaVersion.minor > 0
  ? `^${catalogMediaVersion.major}.${catalogMediaVersion.minor - 1}.0`
  : `^${catalogMediaVersion.major - 1}.0.0`

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProject(mediaRange = compatibleMediaRange): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-media-defaults-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await Promise.all(['db', 'kernel', 'media', 'config'].map(packageName => symlink(
    resolve(import.meta.dirname, `../../${packageName}`),
    join(root, 'node_modules/@holo-js', packageName),
    'dir',
  )))
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'media-defaults-app',
    private: true,
    type: 'module',
    dependencies: {
      '@holo-js/media': mediaRange,
      '@holo-js/db-mysql': mediaRange,
    },
  }))
  await writeFile(join(root, 'config/app.mjs'), 'export default {}\n')
  await writeFile(join(root, 'server/models/Post.mjs'), `import { defineModel } from '@holo-js/db'
import { collection, defineMediaModel } from '@holo-js/media'

export default defineMediaModel(defineModel('posts', { fillable: ['title'] }), {
  collections: [collection('images')],
})
`)

  return root
}

it.each([false, true])('preserves declared Media without an app config when a Media model exists: %s', async (hasMediaModel) => {
  const root = await createProject()
  if (!hasMediaModel) await rm(join(root, 'server/models/Post.mjs'))
  await runProjectPrepare(root)

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  expect(manifest.dependencies['@holo-js/media']).toBe(compatibleMediaRange)
  expect(manifest.dependencies['@holo-js/db-mysql']).toBeUndefined()
  await expect(readFile(join(root, 'config/media.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await loadConfigDirectory(root, { preferCache: false })).media).toEqual({})
})

it('upgrades declared Media from an older release line to the catalog range', async () => {
  const root = await createProject(olderMediaRange)
  await runProjectPrepare(root)

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  expect(manifest.dependencies['@holo-js/media']).toBe(catalogMediaRange)
  expect(manifest.dependencies['@holo-js/db-mysql']).toBeUndefined()
})

it('honors an app Media config override during preparation', async () => {
  const root = await createProject()
  await writeFile(join(root, 'config/media.mjs'), `import { defineMediaConfig } from '@holo-js/media/config'

export default defineMediaConfig({ customDisk: 'public' })
`)
  await runProjectPrepare(root)
  expect((await loadConfigDirectory(root, { preferCache: false })).media).toEqual({ customDisk: 'public' })
})
