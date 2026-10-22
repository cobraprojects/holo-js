import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvironment } from '../src'
import { expandWindowsPercentReferences } from '../src/env'

const tempDirs: string[] = []

async function createEnvProject(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-windows-env-'))
  tempDirs.push(root)
  await writeFile(join(root, '.env'), contents, 'utf8')
  return root
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('expandWindowsPercentReferences', () => {
  it.each([
    ['replaces %NAME% with the process environment value', '%BASE%\\data', { BASE: 'C:\\Holo' }, 'C:\\Holo\\data'],
    ['turns %% into a literal percent sign', '100%% sure', {}, '100% sure'],
    ['reads %%NAME%% as a literal %NAME%', '%%NAME%%', { NAME: 'x' }, '%NAME%'],
    ['leaves an unknown variable exactly as written', '%MISSING%/x', {}, '%MISSING%/x'],
    ['leaves an unterminated percent sign as written', '50%', {}, '50%'],
    ['keeps text between unmatched percent signs', '50% off %NAME', { NAME: 'x' }, '50% off %NAME'],
    ['does not expand the value it inserts', '%A%', { A: '%B%', B: 'x' }, '%B%'],
    ['expands an empty variable to nothing', 'a%EMPTY%b', { EMPTY: '' }, 'ab'],
    ['does not read inherited object properties', '%constructor%', {}, '%constructor%'],
    ['matches variable names case-insensitively, as cmd.exe does', '%userprofile%\\x', { USERPROFILE: 'C:\\U' }, 'C:\\U\\x'],
  ])('%s', (_title, value, processEnv, expected) => {
    expect(expandWindowsPercentReferences(value, processEnv)).toBe(expected)
  })
})

describe('loadEnvironment percent references', () => {
  it('expands %NAME% in .env values on win32 from the process environment only', async () => {
    const root = await createEnvProject([
      'HOLO_WIN_DATA=%HOLO_WIN_BASE%\\data',
      'HOLO_WIN_PERCENT=100%%',
      'HOLO_WIN_UNKNOWN=%HOLO_WIN_NOT_SET%',
      'HOLO_WIN_FILE_ONLY=%HOLO_WIN_FROM_FILE%',
      'HOLO_WIN_FROM_FILE=file',
      '',
    ].join('\n'))

    const environment = await loadEnvironment({
      cwd: root,
      platform: 'win32',
      processEnv: { HOLO_WIN_BASE: 'C:\\Holo' },
    })

    expect(environment.values.HOLO_WIN_DATA).toBe('C:\\Holo\\data')
    expect(environment.values.HOLO_WIN_PERCENT).toBe('100%')
    expect(environment.values.HOLO_WIN_UNKNOWN).toBe('%HOLO_WIN_NOT_SET%')
    expect(environment.values.HOLO_WIN_FILE_ONLY).toBe('%HOLO_WIN_FROM_FILE%')
  })

  it('keeps .env values literal on other platforms', async () => {
    const root = await createEnvProject('HOLO_POSIX_DATA=%HOLO_WIN_BASE%\\data\nHOLO_POSIX_PERCENT=100%%\n')

    const environment = await loadEnvironment({
      cwd: root,
      platform: 'linux',
      processEnv: { HOLO_WIN_BASE: 'C:\\Holo' },
    })

    expect(environment.values.HOLO_POSIX_DATA).toBe('%HOLO_WIN_BASE%\\data')
    expect(environment.values.HOLO_POSIX_PERCENT).toBe('100%%')
  })

  it('passes real environment values through unchanged on win32', async () => {
    const root = await createEnvProject('HOLO_WIN_UNUSED=x\n')

    const environment = await loadEnvironment({
      cwd: root,
      platform: 'win32',
      processEnv: { HOLO_WIN_BASE: 'C:\\Holo', HOLO_WIN_LITERAL: '%HOLO_WIN_BASE%%%' },
    })

    expect(environment.values.HOLO_WIN_LITERAL).toBe('%HOLO_WIN_BASE%%%')
  })
})
