import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const rootTargets = ['playground', 'scripts', 'eslint.config.mjs', 'vitest.workspace.ts']
const passThroughArgs = process.argv.slice(2)
const eslintBaseArgs = ['eslint', '--cache', '--cache-strategy', 'content', '--cache-location', '.eslintcache-main']
const lintExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const ignoredDirectoryNames = new Set([
  '.git',
  '.holo-js',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.vitepress',
  '.vitest-builds',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

/**
 * Run ESLint over smaller batches to keep type-aware linting from
 * exhausting the heap on the full monorepo in one process.
 */
async function main() {
  const groups = [
    ...await buildDirectoryGroups('apps'),
    ...await buildDirectoryGroups('packages'),
    rootTargets,
  ]

  for (const targets of groups) {
    await run(targets)
  }
}

async function listDirectories(parent) {
  const entries = await readdir(parent, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

async function buildDirectoryGroups(parent) {
  const directories = await listDirectories(parent)
  const groups = []

  for (const dir of directories) {
    const target = join(parent, dir)
    if (await hasLintableFiles(target)) {
      groups.push([target])
    }
  }

  return groups
}

async function hasLintableFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) {
        continue
      }

      if (await hasLintableFiles(join(directory, entry.name))) {
        return true
      }

      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if (entry.name.endsWith('.d.ts')) {
      continue
    }

    for (const extension of lintExtensions) {
      if (entry.name.endsWith(extension)) {
        return true
      }
    }
  }

  return false
}

function run(targets) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bunx',
      [...eslintBaseArgs, ...targets, ...passThroughArgs],
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

      reject(new Error(`ESLint failed for: ${targets.join(', ')}`))
    })

    child.on('error', reject)
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
