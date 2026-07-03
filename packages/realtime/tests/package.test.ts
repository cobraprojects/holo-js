import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as clientApi from '../src/client'
import * as publicApi from '../src/index'
import * as serverApi from '../src/server'

const packageRoot = join(import.meta.dirname, '..')

const publicRuntimeExports = [
  'configureRealtimeClientRuntime',
  'configureRealtimeClientTransport',
  'createBroadcastRealtimeTransport',
  'createRealtimeClient',
  'default',
  'defineRealtimeMutation',
  'defineRealtimeQuery',
  'getRealtimeQueryStore',
  'hasConfiguredRealtimeClientRuntime',
  'hasConfiguredRealtimeClientTransport',
  'hydrateRealtimeQuery',
  'isRealtimeDefinition',
  'mutation',
  'query',
  'realtimeClientInternals',
  'resetRealtimeClientRuntime',
  'useRealtimeMutation',
  'useRealtimeQuery',
] as const

const clientRuntimeExports = [
  'configureRealtimeClientRuntime',
  'configureRealtimeClientTransport',
  'createBroadcastRealtimeTransport',
  'getRealtimeQueryStore',
  'hasConfiguredRealtimeClientRuntime',
  'hasConfiguredRealtimeClientTransport',
  'hydrateRealtimeQuery',
  'realtimeClientInternals',
  'resetRealtimeClientRuntime',
  'useRealtimeMutation',
  'useRealtimeQuery',
] as const

const serverRuntimeExports = [
  'RealtimeAuthUnavailableError',
  'RealtimeError',
  'RealtimeForbiddenError',
  'RealtimeUnauthorizedError',
  'configureRealtimeRuntime',
  'executeRealtimeMutation',
  'executeRealtimeQuery',
  'realtimeRuntimeInternals',
  'realtimeServerInternals',
  'resetRealtimeRuntime',
  'resolveRealtimeDefinition',
  'subscribeRealtimeQuery',
] as const

async function readSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return await readSourceFiles(path)
    }

    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  }))

  return nestedFiles.flat()
}

describe('@holo-js/realtime package surface', () => {
  it('keeps the public runtime export names stable', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...publicRuntimeExports].sort())
    expect(Object.keys(clientApi).sort()).toEqual([...clientRuntimeExports].sort())
    expect(Object.keys(serverApi).sort()).toEqual([...serverRuntimeExports].sort())
  })

  it('keeps package exports limited to the public entrypoints', async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      readonly exports: Readonly<Record<string, unknown>>
    }

    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './client', './server'])
  })

  it('does not introduce SSE route transport in the realtime package source', async () => {
    const sourceFiles = await readSourceFiles(join(packageRoot, 'src'))
    const contents = await Promise.all(sourceFiles.map(async path => await readFile(path, 'utf8')))
    const source = contents.join('\n')

    expect(source).not.toContain('/holo/realtime')
    expect(source).not.toContain('EventSource')
    expect(source).not.toContain('text/event-stream')
    expect(source).not.toContain('server-sent')
  })
})
