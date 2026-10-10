export const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function resolveReleaseManifest(manifest, catalog) {
  const resolvedManifest = structuredClone(manifest)

  for (const sectionName of dependencySections) {
    const section = resolvedManifest[sectionName]
    if (!isObject(section)) {
      continue
    }

    for (const [packageName, version] of Object.entries(section)) {
      if (version !== 'catalog:' && version !== 'workspace:*') {
        continue
      }

      const resolvedVersion = catalog[packageName]
      if (typeof resolvedVersion !== 'string') {
        throw new Error(`Cannot resolve catalog range for ${sectionName}.${packageName}.`)
      }

      section[packageName] = resolvedVersion
    }
  }

  return resolvedManifest
}
