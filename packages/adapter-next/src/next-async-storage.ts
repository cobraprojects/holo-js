import { createRequire } from 'node:module'
import { resolve } from 'node:path'

export type NextWorkUnitStore = {
  readonly type?: string
  readonly phase?: string
  readonly headers?: Headers
  readonly url?: { readonly pathname?: string }
}

export type NextActionStore = {
  readonly isAction?: boolean
  readonly isAppRoute?: boolean
}

type NextAsyncStorage<TStore> = { getStore(): TStore | undefined }

export function requireNextFromProject(): (id: string) => unknown {
  return createRequire(resolve(process.cwd(), 'package.json'))
}

export function loadNextAsyncStorage<TStore>(requireNext: (id: string) => unknown, name: 'work-unit' | 'action'): NextAsyncStorage<TStore> | undefined {
  try {
    const storage = requireNext(`next/dist/server/app-render/${name}-async-storage.external.js`) as Readonly<Record<string, NextAsyncStorage<TStore>>>
    return storage[name === 'action' ? 'actionAsyncStorage' : 'workUnitAsyncStorage']
  } catch {
    return undefined
  }
}

export function currentWorkUnitStore(): NextWorkUnitStore | undefined {
  return loadNextAsyncStorage<NextWorkUnitStore>(requireNextFromProject(), 'work-unit')?.getStore()
}
