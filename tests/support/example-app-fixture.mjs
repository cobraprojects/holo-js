import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const generatedDirectories = new Set(['node_modules', 'storage', '.holo-js', '.next', '.nuxt', '.output', '.svelte-kit', 'build', 'dist'])

export async function createExampleAppFixture(root, framework) {
  const directory = await mkdtemp(join(root, '.holo-test-example-app-'))
  const projectRoot = join(directory, 'apps', `blog-${framework}`)
  const sourceRoot = join(root, 'apps', `blog-${framework}`)
  try {
    await mkdir(join(directory, 'apps'))
    await cp(sourceRoot, projectRoot, {
      recursive: true,
      filter: source => !generatedDirectories.has(relative(sourceRoot, source).split(sep)[0]),
    })
    await mkdir(join(projectRoot, 'storage'))
    const manifestPath = join(projectRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'))
    if (manifest?.scripts?.prepare) {
      manifest.scripts.prepare = 'holo key:generate && holo prepare'
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    for (const name of ['packages', 'tests', 'node_modules']) {
      await symlink(join(root, name), join(directory, name), 'dir')
    }
    await symlink(join(root, 'apps', `blog-${framework}`, 'node_modules'), join(projectRoot, 'node_modules'), 'dir')
    return { directory, projectRoot }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
