import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateCliWorkspaceCatalog } from './generate-cli-workspace-catalog.mjs'
import { writeWorkspaceBuildMarker } from './workspace-build-fingerprint.mjs'

export function collectLibraryBuilds(rootDir, packageNames) {
  const packagesRoot = join(rootDir, 'packages')
  const packages = new Map(readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const directory = join(packagesRoot, entry.name)
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      return [manifest.name, { directory, manifest }]
    }))
  const builds = []
  const built = new Set()
  const visiting = new Set()

  function visit(name) {
    if (built.has(name)) return
    if (visiting.has(name)) throw new Error(`Circular library build dependency: ${[...visiting, name].join(' -> ')}`)
    const entry = packages.get(name)
    if (!entry) return

    visiting.add(name)
    const dependencies = {
      ...entry.manifest.dependencies,
      ...entry.manifest.optionalDependencies,
      ...entry.manifest.peerDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) visit(dependency)
    visiting.delete(name)
    built.add(name)
    if (entry.manifest.scripts?.build) builds.push({ name, directory: entry.directory })
  }

  for (const name of packageNames ?? [...packages.keys()].sort()) visit(name)
  return builds
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await generateCliWorkspaceCatalog(resolve(import.meta.dirname, '..'))
  for (const { name, directory } of collectLibraryBuilds(resolve(import.meta.dirname, '..'))) {
    console.log(`Building ${name}`)
    const result = spawnSync('bun', ['run', 'build'], { cwd: directory, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
    writeWorkspaceBuildMarker(directory, resolve(import.meta.dirname, '..'))
  }
}
