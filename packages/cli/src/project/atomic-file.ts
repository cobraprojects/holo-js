import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function stageFile(path: string, contents: string | Uint8Array): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.holo-${process.pid}-${randomUUID()}.tmp`
  try {
    const handle = await open(temporaryPath, 'w')
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
  return await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path
    throw error
  })
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const targetPath = await resolveWriteTarget(path)
  const existingMode = await stat(targetPath).then(stats => stats.mode & 0o7777, () => undefined)
  const temporaryPath = await stageFile(targetPath, contents)
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
