import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const appRoot = 'apps'
const passThroughArgs = process.argv.slice(2)

async function main() {
  const groups = await collectGeneratedLintGroups()

  for (const group of groups) {
    await run(group)
  }
}

async function collectGeneratedLintGroups() {
  const appEntries = await readdir(appRoot, { withFileTypes: true })
  const groups = []

  for (const entry of appEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const appPath = join(appRoot, entry.name)
    const group = await collectGeneratedTargets(appPath)
    if (group.length > 0) {
      groups.push(group)
    }
  }

  return groups
}

async function collectGeneratedTargets(appPath) {
  const targets = []
  const frameworkRunPath = join(appPath, '.holo-js', 'framework', 'run.mjs')
  const generatedDir = join(appPath, '.holo-js', 'generated')

  if (await pathExists(frameworkRunPath)) {
    targets.push(frameworkRunPath)
  }

  if (!(await pathExists(generatedDir))) {
    return targets
  }

  const entries = await readdir(generatedDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    if (
      entry.name.endsWith('.ts')
      || entry.name.endsWith('.d.ts')
      || entry.name.endsWith('.mjs')
    ) {
      targets.push(join(generatedDir, entry.name))
    }
  }

  return targets.sort()
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function run(targets) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bunx',
      ['eslint', '--no-ignore', ...targets, ...passThroughArgs],
      {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    )

    child.on('exit', code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`Generated ESLint failed for: ${targets[0]}`))
    })

    child.on('error', reject)
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
