import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GeneratedJobRegistryEntry } from '../src/project'
import { installSecurityIntoProject } from '../src/project'
import { renderGeneratedQueueTypes } from '../src/project/registry'

const tempDirs: string[] = []
const configPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-regression-'))
  tempDirs.push(root)

  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    dependencies: {},
  }, null, 2), 'utf8')
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configPackageEntry}

export default defineAppConfig({
  name: 'Fixture',
})
`, 'utf8')

  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('cli regressions', () => {
  it('preserves existing rate-limit gitignore rules when installing security', async () => {
    const root = await createProject()
    const ignorePath = join(root, 'storage/framework/rate-limits/.gitignore')

    await mkdir(join(root, 'storage/framework/rate-limits'), { recursive: true })
    await writeFile(ignorePath, 'custom-rule\n', 'utf8')

    await installSecurityIntoProject(root)

    await expect(readFile(ignorePath, 'utf8')).resolves.toBe([
      'custom-rule',
      '*',
      '!.gitignore',
      '',
    ].join('\n'))
  })

  it('renders queue type imports in the stable order and keeps a separator without local imports', () => {
    const output = renderGeneratedQueueTypes([
      {
        sourcePath: 'server/jobs/send-email.js',
        name: 'send-email',
        connection: 'sync',
        queue: 'default',
      },
      {
        sourcePath: 'server/jobs/reports/daily.ts',
        name: 'reports.daily',
        exportName: 'dailyJob',
        connection: 'sync',
        queue: 'default',
      },
    ] satisfies readonly GeneratedJobRegistryEntry[])

    expect(output).toMatch(/import type \{\n {2}QueueJobDefinition,\n {2}ExportedQueueJobDefinition,\n\} from '@holo-js\/queue'/)

    const untypedOnlyOutput = renderGeneratedQueueTypes([
      {
        sourcePath: 'server/jobs/send-email.js',
        name: 'send-email',
        connection: 'sync',
        queue: 'default',
      },
    ] satisfies readonly GeneratedJobRegistryEntry[])

    expect(untypedOnlyOutput).toContain([
      'import type {',
      '  QueueJobDefinition,',
      '} from \'@holo-js/queue\'',
      '',
      'declare module \'@holo-js/queue\' {',
    ].join('\n'))
  })
})
