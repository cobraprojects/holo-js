import { stat } from 'node:fs/promises'
import { readTextFile } from './project'

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function ensureAbsent(path: string): Promise<void> {
  const existing = await readTextFile(path)
  if (typeof existing !== 'undefined') {
    throw new TypeError(`Refusing to overwrite existing file: ${path}`)
  }
}
