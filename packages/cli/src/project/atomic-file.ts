import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export async function stageFile(path: string, contents: string | Uint8Array, mode?: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.holo-${process.pid}-${randomUUID()}.tmp`
  try {
    const handle = await open(temporaryPath, 'w', mode)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  return temporaryPath
}

async function resolveWriteTarget(path: string): Promise<string> {
  return await realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    const stats = await lstat(path).catch((lstatError: NodeJS.ErrnoException) => {
      if (lstatError.code === 'ENOENT') return undefined
      throw lstatError
    })
    return stats?.isSymbolicLink() ? resolve(dirname(path), await readlink(path)) : path
  })
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const targetPath = await resolveWriteTarget(path)
  const existingMode = await stat(targetPath).then(stats => stats.mode & 0o7777, () => undefined)
  const temporaryPath = await stageFile(targetPath, contents, existingMode === undefined ? undefined : 0o600)
  try {
    if (existingMode !== undefined) {
      await chmod(temporaryPath, existingMode)
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
