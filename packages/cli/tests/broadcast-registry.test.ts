import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHoloProjectConfig } from '@holo-js/db'
import { prepareProjectDiscovery } from '../src/project/discovery'
import { loadGeneratedProjectRegistry, writeGeneratedProjectRegistry } from '../src/project/registry'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const broadcastContractsModulePath = join(workspaceRoot, 'packages/broadcast/src/contracts.ts')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-registry-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, 'server/broadcast/orders'), { recursive: true })
  await mkdir(join(root, 'server/channels'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'broadcast-registry-fixture',
    private: true,
  }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await Promise.all([
    symlink(join(workspaceRoot, 'packages/broadcast'), join(root, 'node_modules/@holo-js/broadcast')),
    symlink(join(workspaceRoot, 'packages/config'), join(root, 'node_modules/@holo-js/config')),
    symlink(join(workspaceRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db')),
    symlink(join(workspaceRoot, 'packages/validation'), join(root, 'node_modules/@holo-js/validation')),
  ])
  return root
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/cli broadcast registry discovery', () => {
  it('discovers normalized broadcast definitions and emits client-safe manifest/types', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/broadcast/orders/updated.ts'), `
import { defineBroadcast, privateChannel, presenceChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export const orderUpdated = defineBroadcast({
  name: 'orders.updated',
  channels: [
    privateChannel('orders.{orderId}', { orderId: 'ord_1' }),
    presenceChannel('chat.{roomId}', { roomId: 'room_1' }),
  ],
  payload: {
    orderId: 'ord_1',
    status: 'shipped',
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/channels/orders-channel.ts'), `
import { defineChannel } from ${JSON.stringify(broadcastContractsModulePath)}

const typingSchema = {
  '~standard': {},
}

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return true
  },
  whispers: {
    'typing.start': typingSchema,
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/channels/chat-channel.ts'), `
import { defineChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineChannel('chat.{roomId}', {
  type: 'presence',
  authorize() {
    return {
      id: 'user-1',
      role: 'moderator',
    }
  },
  whispers: {},
})
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(registry.paths.broadcast).toBe('server/broadcast')
    expect(registry.paths.channels).toBe('server/channels')
    expect(registry.broadcast).toEqual([{
      sourcePath: 'server/broadcast/orders/updated.ts',
      name: 'orders.updated',
      exportName: 'orderUpdated',
      channels: [
        {
          type: 'private',
          pattern: 'orders.{orderId}',
        },
        {
          type: 'presence',
          pattern: 'chat.{roomId}',
        },
      ],
    }])
    expect(registry.channels).toEqual([{
      sourcePath: 'server/channels/chat-channel.ts',
      pattern: 'chat.{roomId}',
      exportName: 'default',
      type: 'presence',
      params: ['roomId'],
      whispers: [],
    }, {
      sourcePath: 'server/channels/orders-channel.ts',
      pattern: 'orders.{orderId}',
      exportName: 'default',
      type: 'private',
      params: ['orderId'],
      whispers: ['typing.start'],
    }])

    await expect(loadGeneratedProjectRegistry(root)).resolves.toMatchObject({
      broadcast: registry.broadcast,
      channels: registry.channels,
    })
    await expect(readFile(join(root, '.holo-js/generated/broadcast.ts'), 'utf8')).resolves.toContain('"exportName": "orderUpdated"')
    await expect(readFile(join(root, '.holo-js/generated/channels.ts'), 'utf8')).resolves.toContain('"whispers": [')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.toContain('events: [')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.toContain('"typing.start"')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.not.toContain('import type { GeneratedBroadcastManifest } from \'@holo-js/core\'')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.toContain('type GeneratedBroadcastManifest = {')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.toContain('import type { ChannelPresenceMemberFor } from \'@holo-js/broadcast\'')
    await expect(readFile(join(root, '.holo-js/generated/broadcast-manifest.ts'), 'utf8')).resolves.toContain('member: undefined as unknown as ChannelPresenceMemberFor<"chat.{roomId}">')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('declare module \'@holo-js/broadcast\'')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('ExportedBroadcastDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('ExportedChannelDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.updated": ExportedBroadcastDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.{orderId}": ExportedChannelDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.not.toContain('authorize()')
  })

  it('derives broadcast names from file paths and keeps generatedAt stable', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/broadcast/orders/path-derived.ts'), `
import { defineBroadcast, privateChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineBroadcast({
  channels: [
    privateChannel('orders.{orderId}', { orderId: 'ord_1' }),
  ],
  payload: {
    orderId: 'ord_1',
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/channels/orders-channel.ts'), `
import { defineChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return true
  },
  whispers: {},
})
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())
    expect(registry.broadcast).toEqual([{
      sourcePath: 'server/broadcast/orders/path-derived.ts',
      name: 'orders.path-derived',
      exportName: 'default',
      channels: [{
        type: 'private',
        pattern: 'orders.{orderId}',
      }],
    }])
    expect(registry.channels).toEqual([{
      sourcePath: 'server/channels/orders-channel.ts',
      pattern: 'orders.{orderId}',
      exportName: 'default',
      type: 'private',
      params: ['orderId'],
      whispers: [],
    }])

    const firstRegistry = await loadGeneratedProjectRegistry(root)
    if (!firstRegistry) {
      throw new Error('Expected generated registry after discovery.')
    }
    await writeGeneratedProjectRegistry(root, {
      ...firstRegistry,
      generatedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const secondRegistry = await loadGeneratedProjectRegistry(root)
    expect(secondRegistry?.generatedAt).toBe(firstRegistry.generatedAt)
  })

  it('derives channel params from the fallback pattern when pattern is omitted', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/channels/orders/{orderId}'), { recursive: true })
    await writeFile(join(root, 'server/channels/orders/{orderId}/index.ts'), `
const marker = Symbol.for('holo-js.broadcast.channel')

export default Object.freeze({
  [marker]: true,
  type: 'private',
  authorize() {
    return true
  },
  whispers: {},
})
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())
    expect(registry.channels).toEqual([{
      sourcePath: 'server/channels/orders/{orderId}/index.ts',
      pattern: 'orders.{orderId}.index',
      exportName: 'default',
      type: 'private',
      params: ['orderId'],
      whispers: [],
    }])
  })

  it('uses broad fallback types for JavaScript broadcast/channel entries', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/broadcast/orders/updated.js'), `
import { defineBroadcast, privateChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export const orderUpdated = defineBroadcast({
  name: 'orders.updated',
  channels: [
    privateChannel('orders.{orderId}', { orderId: 'ord_1' }),
  ],
  payload: {
    orderId: 'ord_1',
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/channels/orders-channel.js'), `
import { defineChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return true
  },
  whispers: {},
})
`, 'utf8')

    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('BroadcastDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('ChannelDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.updated": BroadcastDefinition')
    await expect(readFile(join(root, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.{orderId}": ChannelDefinition')
  })

  it('discovers broadcast artifacts from configured custom paths', async () => {
    const root = await createProject()
    await mkdir(join(root, 'app/broadcast'), { recursive: true })
    await mkdir(join(root, 'app/channels'), { recursive: true })
    await writeFile(join(root, 'app/broadcast/orders.ts'), `
import { defineBroadcast, privateChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineBroadcast({
  channels: [
    privateChannel('orders.{orderId}', { orderId: 'ord_1' }),
  ],
  payload: {
    orderId: 'ord_1',
  },
})
`, 'utf8')
    await writeFile(join(root, 'app/channels/orders.ts'), `
import { defineChannel } from ${JSON.stringify(broadcastContractsModulePath)}

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return true
  },
  whispers: {},
})
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig({
      paths: {
        broadcast: 'app/broadcast',
        channels: 'app/channels',
      } as never,
    }))

    expect(registry.paths.broadcast).toBe('app/broadcast')
    expect(registry.paths.channels).toBe('app/channels')
    expect(registry.broadcast[0]?.sourcePath).toBe('app/broadcast/orders.ts')
    expect(registry.channels[0]?.sourcePath).toBe('app/channels/orders.ts')
  })

  it('throws a clear error when discovered broadcast files export no broadcast definition', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/broadcast/orders/updated.ts'), 'export const nope = { ok: true }\n', 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'does not export a Holo broadcast definition',
    )
  })

  it('throws a clear error when discovered channel files export no channel definition', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/channels/orders-channel.ts'), 'export const nope = { ok: true }\n', 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'does not export a Holo channel definition',
    )
  })
})
