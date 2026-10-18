import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function stageFile(path: string, contents: string | Uint8Array): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.holo-${process.pid}-${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'w')
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  return temporaryPath
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const existingMode = await stat(path).then(stats => stats.mode & 0o7777, () => undefined)
  const temporaryPath = await stageFile(path, contents)
  try {
    if (existingMode !== undefined) {
      await chmod(temporaryPath, existingMode)
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
