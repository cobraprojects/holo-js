export const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const workspaceSourceCondition = '@holo-js/source'

function withoutWorkspaceSourceCondition(exports) {
  if (!isObject(exports)) {
    return exports
  }

  const entries = Object.entries(exports)
    .filter(([condition]) => condition !== workspaceSourceCondition)
    .map(([key, target]) => [key, withoutWorkspaceSourceCondition(target)])
  const [onlyEntry] = entries
  return entries.length === 1 && onlyEntry[0] === 'default' && Object.hasOwn(exports, workspaceSourceCondition)
    ? onlyEntry[1]
    : Object.fromEntries(entries)
}

export function resolveReleaseManifest(manifest, catalog) {
  const resolvedManifest = resolveCatalogRanges(manifest, catalog)
  if (resolvedManifest.exports !== undefined) {
    resolvedManifest.exports = withoutWorkspaceSourceCondition(resolvedManifest.exports)
  }

  return resolvedManifest
}

export function resolveCatalogRanges(manifest, catalog) {
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
