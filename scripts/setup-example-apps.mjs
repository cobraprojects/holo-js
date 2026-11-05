import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function exampleApps(rootDir) {
  const appsDir = join(rootDir, 'apps')
  return readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter((name) => {
      const manifestPath = join(appsDir, name, 'package.json')
      return existsSync(manifestPath) && Boolean(JSON.parse(readFileSync(manifestPath, 'utf8')).scripts?.setup)
    })
    .sort()
}

export function selectExampleApps(available, requested) {
  if (requested.length === 0) return available
  const unknown = requested.filter(name => !available.includes(name))
  if (unknown.length > 0) {
    throw new Error(`Unknown example app: ${unknown.join(', ')}. Choose from ${available.join(', ')}.`)
  }
  return requested
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rootDir = resolve(import.meta.dirname, '..')
  let apps
  try {
    apps = selectExampleApps(exampleApps(rootDir), process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (!existsSync(join(rootDir, 'packages/cli/dist/bin/holo.mjs'))) {
    console.error('The holo CLI is not built. Run `bun run build` before `bun run setup:examples`.')
    process.exit(1)
  }
  run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], rootDir)
  for (const app of apps) {
    console.log(`Setting up apps/${app}`)
    run('bun', ['run', 'setup'], join(rootDir, 'apps', app))
  }
}
