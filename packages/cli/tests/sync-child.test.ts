import type * as ChildProcess from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killSyncChildTree } from './sync-child'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, spawnSync: vi.fn() }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawnSync).mockReset()
})

describe('killSyncChildTree', () => {
  it.each([
    ['undefined', undefined],
    ['0', 0],
    ['-0', -0],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['1.5', 1.5],
  ])('never signals a process group for pid %s', (_label, pid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    expect(() => killSyncChildTree(pid, 'linux')).not.toThrow()
    expect(kill).not.toHaveBeenCalled()
  })

  it('never runs a Windows tree kill for an invalid pid', () => {
    expect(() => killSyncChildTree(0, 'win32')).not.toThrow()
    expect(() => killSyncChildTree(undefined, 'win32')).not.toThrow()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('signals the whole process group of a positive pid on POSIX', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    killSyncChildTree(4242, 'linux')

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
  })

  it('bounds the Windows tree kill with a timeout and hides its window', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never)

    killSyncChildTree(4242, 'win32')

    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', '4242'],
      expect.objectContaining({ timeout: 10_000, windowsHide: true }),
    )
  })
})
