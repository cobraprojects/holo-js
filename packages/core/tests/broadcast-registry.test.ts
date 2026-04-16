import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadGeneratedBroadcastManifest,
  loadGeneratedProjectRegistry,
  registryInternals,
} from '../src/portable/registry'

const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-broadcast-registry-'))
  tempDirs.push(root)
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  return root
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/core generated registry broadcast support', () => {
  it('recognizes generated broadcast and channel registry entries', async () => {
    const root = await createProject()
    await writeFile(join(root, '.holo-js/generated/registry.json'), JSON.stringify({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [{
        sourcePath: 'server/broadcast/orders/updated.ts',
        name: 'orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }],
      channels: [{
        sourcePath: 'server/channels/orders.{orderId}.ts',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: ['typing.start'],
      }],
    }, null, 2))

    await expect(loadGeneratedProjectRegistry(root)).resolves.toMatchObject({
      paths: {
        broadcast: 'server/broadcast',
        channels: 'server/channels',
      },
      broadcast: [{
        name: 'orders.updated',
      }],
      channels: [{
        pattern: 'orders.{orderId}',
      }],
    })

    await expect(loadGeneratedBroadcastManifest(root)).resolves.toEqual({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      events: [{
        name: 'orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }],
      channels: [{
        name: 'orders.{orderId}',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: ['typing.start'],
      }],
    })
  })

  it('fills broadcast and channel fields for legacy registry validation', () => {
    expect(registryInternals.isGeneratedProjectRegistry({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
    })).toBe(true)
  })

  it('returns undefined manifest when registry does not exist', async () => {
    const root = await createProject()
    await expect(loadGeneratedBroadcastManifest(root)).resolves.toBeUndefined()
  })
})
