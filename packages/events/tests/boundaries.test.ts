import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const allowedHoloImports = new Set([
  '@holo-js/db',
  '@holo-js/queue',
])

async function listSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }

    if (entry.isFile() && fullPath.endsWith('.ts')) {
      return [fullPath]
    }

    return []
  }))

  return files.flat()
}

describe('@holo-js/events package boundaries', () => {
  it('only imports allowed Holo packages from the runtime source', async () => {
    const sourceRoot = resolve(import.meta.dirname, '../src')
    const sourceFiles = await listSourceFiles(sourceRoot)
    const invalidImports: string[] = []

    for (const filePath of sourceFiles) {
      const contents = await readFile(filePath, 'utf8')
      const imports = [...contents.matchAll(/from\s+['"](@holo-js\/[^'"]+)['"]/g)]
        .map(match => match[1])

      for (const moduleSpecifier of imports) {
        if (!allowedHoloImports.has(moduleSpecifier)) {
          invalidImports.push(`${moduleSpecifier} in ${filePath}`)
        }
      }
    }

    expect(invalidImports).toEqual([])
  })

  it('keeps package dependencies aligned with runtime boundary rules', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(['@holo-js/db'])
    expect(packageJson.peerDependencies?.['@holo-js/queue']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/queue']?.optional).toBe(true)
  })
})
