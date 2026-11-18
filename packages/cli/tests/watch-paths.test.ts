import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { isVanishedEntryUnderWatchRoot } from '../src/watch-paths'

const root = resolve('/project')
const missing = (path?: string, code = 'ENOENT') => Object.assign(new Error(`${code}: scandir '${path}'`), { code, ...(path === undefined ? {} : { path }) })

it('recognizes an entry that vanished below the watched root, including names that start with two dots', () => {
  expect(isVanishedEntryUnderWatchRoot(missing(join(root, '.holo-js/runtime/cli/bundle-1')), root)).toBe(true)
  expect(isVanishedEntryUnderWatchRoot(missing(join(root, '..cache/tmp')), root)).toBe(true)
  expect(isVanishedEntryUnderWatchRoot(missing(join(root, '..')), root)).toBe(false)
})

it('rejects errors for the watched root itself, paths outside it, other codes and errors without a path', () => {
  expect(isVanishedEntryUnderWatchRoot(missing(root), root)).toBe(false)
  expect(isVanishedEntryUnderWatchRoot(missing(resolve('/project-other/tmp')), root)).toBe(false)
  expect(isVanishedEntryUnderWatchRoot(missing(resolve('/elsewhere')), root)).toBe(false)
  expect(isVanishedEntryUnderWatchRoot(missing(join(root, 'tmp'), 'EPERM'), root)).toBe(false)
  expect(isVanishedEntryUnderWatchRoot(missing(), root)).toBe(false)
  expect(isVanishedEntryUnderWatchRoot('ENOENT', root)).toBe(false)
})
