import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function removeStaleGeneratedConfigs(generatedConfigsPrefix) {
  const parentDir = dirname(generatedConfigsPrefix)
  const directoryNamePrefix = basename(generatedConfigsPrefix)
  const entries = await readdir(parentDir, { withFileTypes: true })
  const staleDirectories = entries.filter(entry => (
    entry.isDirectory() && entry.name.startsWith(directoryNamePrefix)
  ))

  await Promise.all(staleDirectories.map(entry => (
    rm(join(parentDir, entry.name), { recursive: true, force: true })
  )))
}
