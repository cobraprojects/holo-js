import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runTypecheckJobs } from './typecheck-runner.mjs'

const packagesRoot = resolve('packages')

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function collectLibraryTypecheckJobs() {
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const jobs = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue
    }

    const packageDir = join(packagesRoot, entry.name)
    const configPath = join(packageDir, 'tsconfig.json')
    if (!(await pathExists(configPath))) {
      continue
    }

    jobs.push({ name: `${entry.name} [src]`, configPath })
  }

  return jobs
}

async function main() {
  await runTypecheckJobs(await collectLibraryTypecheckJobs(), 'Library typecheck')
}

const entrypoint = process.argv[1]
if (typeof entrypoint === 'string' && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
