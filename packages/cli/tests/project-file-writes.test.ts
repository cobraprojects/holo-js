import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeTextFile } from '../src/project/atomic-file'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function manifestWith(version: number): string {
  const dependencies = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => [`package-${index}`, `^${version}.0.0`]))
  return `${JSON.stringify({ name: 'app', dependencies }, null, 2)}\n`
}

it('never exposes a partially written file to concurrent readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-file-writes-'))
  tempRoots.push(root)
  const manifestPath = join(root, 'package.json')
  const versions = [manifestWith(1), manifestWith(2)]
  await writeTextFile(manifestPath, versions[0]!)

  let writing = true
  const observed = new Set<string>()
  const reader = (async () => {
    while (writing) {
      const contents = await readFile(manifestPath, 'utf8')
      observed.add(versions.includes(contents) ? 'complete' : 'partial')
    }
  })()
  for (let index = 0; index < 40; index += 1) {
    await writeTextFile(manifestPath, versions[index % 2]!)
  }
  writing = false
  await reader

  expect(observed).toEqual(new Set(['complete']))
  expect(await readdir(root)).toEqual(['package.json'])
})

it.skipIf(process.platform === 'win32')('keeps the permissions of a file it rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-file-modes-'))
  tempRoots.push(root)
  const scriptPath = join(root, 'script.sh')
  await writeFile(scriptPath, '#!/bin/sh\nexit 0\n')
  await chmod(scriptPath, 0o750)

  await writeTextFile(scriptPath, '#!/bin/sh\nexit 1\n')

  expect((await stat(scriptPath)).mode & 0o777).toBe(0o750)
  expect(await readFile(scriptPath, 'utf8')).toBe('#!/bin/sh\nexit 1\n')
})

it.skipIf(process.platform === 'win32')('rewrites the target of a symlinked file and keeps the link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-file-links-'))
  tempRoots.push(root)
  const sharedEnvPath = join(root, 'shared.env')
  const linkedEnvPath = join(root, '.env')
  await writeFile(sharedEnvPath, 'APP_KEY=\n')
  await symlink(sharedEnvPath, linkedEnvPath)

  await writeTextFile(linkedEnvPath, 'APP_KEY=base64:generated\n')

  expect((await lstat(linkedEnvPath)).isSymbolicLink()).toBe(true)
  expect(await readFile(sharedEnvPath, 'utf8')).toBe('APP_KEY=base64:generated\n')
})
