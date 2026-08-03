import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function clearExampleAppRateLimitBuckets(projectRoot) {
  const rateLimitPath = join(projectRoot, 'storage/framework/rate-limits')
  const entries = await readdir(rateLimitPath, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter(entry => entry.name !== '.gitignore')
    .map(entry => rm(join(rateLimitPath, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    })))
}
