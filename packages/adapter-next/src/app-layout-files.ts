export const DEFAULT_PAGE_EXTENSIONS: readonly string[] = ['tsx', 'ts', 'jsx', 'js']

function extensionsPattern(pageExtensions: readonly string[]): string {
  return pageExtensions.map(extension => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}

export function layoutFileNamePattern(pageExtensions: readonly string[]): RegExp {
  return new RegExp(`^layout\\.(?:${extensionsPattern(pageExtensions)})$`)
}

export function appLayoutPathPattern(pageExtensions: readonly string[]): RegExp {
  return new RegExp(`(?:^|[\\\\/])app[\\\\/](?:.*[\\\\/])?layout\\.(?:${extensionsPattern(pageExtensions)})$`)
}
