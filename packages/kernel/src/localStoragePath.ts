const WINDOWS_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...['COM', 'LPT'].flatMap(device => ['1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].map(digit => `${device}${digit}`)),
])

function windowsStorageNameProblem(name: string): string | null {
  const hasControlCharacter = Array.from(name).some(character => character.charCodeAt(0) < 32)
  if (hasControlCharacter || /[<>:"|?*]/u.test(name)) {
    return 'Windows file names cannot contain < > : " | ? * or control characters'
  }
  if (/[. ]$/u.test(name)) {
    return 'Windows file names cannot end with a dot or a space'
  }
  const baseName = (name.split('.', 1)[0] ?? '').replace(/ +$/u, '').toUpperCase()
  if (WINDOWS_DEVICE_NAMES.has(baseName)) {
    return 'Windows reserves this device name'
  }

  return null
}

function segmentProblem(segment: string): string | null {
  if (segment === '..') {
    return 'Storage paths must not contain ".." segments'
  }
  if (segment === '' || segment === '.' || /[\\/]/u.test(segment) || segment.includes('\u0000')) {
    return 'Storage path segments must be file or folder names'
  }

  return process.platform === 'win32' ? windowsStorageNameProblem(segment) : null
}

function assertValidSegment(segment: string): void {
  const problem = segmentProblem(segment)
  if (problem) throw new Error(`[Holo Storage] ${problem}.`)
}

function splitLocalStoragePath(path: string): string[] {
  return path.trimStart().replace(/\\/g, '/').split('/').filter(Boolean)
}

function isReservedLocalStorageName(name: string | undefined): boolean {
  return name?.endsWith('$') === true
}

export const localStoragePathInternals = {
  assertValidSegment,
  isReservedLocalStorageName,
  segmentProblem,
  splitLocalStoragePath,
  windowsStorageNameProblem,
}
