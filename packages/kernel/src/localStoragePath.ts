const WINDOWS_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
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

export const localStoragePathInternals = { assertValidSegment, segmentProblem, windowsStorageNameProblem }
