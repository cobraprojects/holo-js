import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')

it.each(['missing', 'broken'] as const)('rejects S3 configuration with a physically %s driver package', async scenario => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-native-nuxt-storage-'))
  try {
    await mkdir(join(projectRoot, 'config'), { recursive: true })
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(projectRoot, 'config/storage.mjs'), "export default { disks: { media: { driver: 's3', bucket: 'media-bucket', region: 'us-east-1' } } }")
    for (const name of ['adapter-nuxt', 'storage']) {
      await stagePublishedPackage(join(root, 'packages', name), join(projectRoot, 'node_modules/@holo-js', name), join(root, 'packages', name, 'dist'))
    }
    await symlink(join(root, 'packages/adapter-nuxt/node_modules/nuxt'), join(projectRoot, 'node_modules/nuxt'))
    if (scenario === 'broken') {
      await stagePublishedPackage(join(root, 'packages/storage-s3'), join(projectRoot, 'node_modules/@holo-js/storage-s3'), join(root, 'packages/storage-s3/dist'))
      await writeFile(join(projectRoot, 'node_modules/@holo-js/storage-s3/dist/index.mjs'), 'const broken = )')
    }
    const result = await execute(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { loadNuxt } from 'nuxt/kit'
import holo from '@holo-js/adapter-nuxt'
const nuxt = await loadNuxt({ cwd: process.cwd(), ready: false, dev: false, overrides: { modules: [] } })
try {
  await assert.rejects(nuxt.runWithContext(() => holo({}, nuxt)), ${scenario === 'missing' ? "{ message: '[@holo-js/adapter-nuxt] S3 storage disks require @holo-js/storage-s3 to be installed.' }" : 'SyntaxError'})
  console.log('Native optional driver behavior passed')
} finally {
  await nuxt.close()
}
`], { cwd: projectRoot })
    expect(result.stdout).toContain('Native optional driver behavior passed')
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}, 30000)
