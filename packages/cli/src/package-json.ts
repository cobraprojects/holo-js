import { join } from 'node:path'
import { readTextFile } from './project'

export async function hasProjectDependency(projectRoot: string, packageName: string): Promise<boolean> {
  const packageJson = await readTextFile(join(projectRoot, 'package.json'))
  if (!packageJson) {
    return false
  }

  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof parsed.dependencies?.[packageName] === 'string'
      || typeof parsed.devDependencies?.[packageName] === 'string'
  } catch {
    return false
  }
}
