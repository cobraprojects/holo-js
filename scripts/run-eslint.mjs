import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const rootTargets = ['playground', 'scripts', 'eslint.config.mjs', 'vitest.workspace.ts']
const passThroughArgs = process.argv.slice(2)
const cacheLocation = '.eslintcache-main'
const eslintBaseArgs = ['eslint', '--cache', '--cache-strategy', 'content', '--cache-location', cacheLocation]
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
  let retriedAfterCacheReset = false

  for (const targets of groups) {
    try {
      await run(targets)
    } catch (error) {
      if (!retriedAfterCacheReset && shouldResetCache(error)) {
        retriedAfterCacheReset = true
        await clearCache(cacheLocation)
        await run(targets)
        continue
      }

      throw error
    }
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
    let stderr = ''
    const child = spawn(
      'bunx',
      [...eslintBaseArgs, ...targets, ...passThroughArgs],
      {
        stdio: ['inherit', 'inherit', 'pipe'],
        shell: process.platform === 'win32',
      },
    )

    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    child.on('exit', code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr || `ESLint failed for: ${targets.join(', ')}`))
    })

    child.on('error', reject)
  })
}

async function clearCache(path) {
  await rm(path, { force: true }).catch(() => undefined)
}

function shouldResetCache(error) {
  return error instanceof Error
    && error.message.includes('ENOENT:')
    && error.message.includes('timestamp-')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
