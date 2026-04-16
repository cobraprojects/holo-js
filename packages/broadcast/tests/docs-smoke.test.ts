import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readBroadcastDoc(name: string): Promise<string> {
  return readFile(resolve(root, 'apps/docs/docs/broadcast', name), 'utf8')
}

describe('broadcast documentation smoke checks', () => {
  it('covers package boundaries and setup/cli flow', async () => {
    const overview = await readBroadcastDoc('index.md')
    const setup = await readBroadcastDoc('setup-and-cli.md')
    const installation = await readFile(resolve(root, 'apps/docs/docs/installation.md'), 'utf8')

    expect(overview).toContain('@holo-js/broadcast')
    expect(overview).toContain('@holo-js/flux')
    expect(overview).toContain('@holo-js/flux-react')
    expect(overview).toContain('@holo-js/flux-vue')
    expect(overview).toContain('@holo-js/flux-svelte')
    expect(overview).toContain('defineBroadcast(...)')
    expect(overview).toContain('defineChannel(...)')
    expect(overview).toContain('useFlux(...)')
    expect(setup).toContain('holo install broadcast')
    expect(setup).toContain('holo make:broadcast orders/shipment-updated')
    expect(setup).toContain('holo make:channel orders.{orderId}')
    expect(setup).toContain('holo broadcast:work')
    expect(setup).toContain('npx holo broadcast:work')
    expect(installation).toContain('bunx holo install broadcast')
  })

  it('covers drivers, auth endpoint, Flux helpers, deployment, and notifications bridge', async () => {
    const drivers = await readBroadcastDoc('config-and-drivers.md')
    const authoring = await readBroadcastDoc('defining-events-and-channels.md')
    const flux = await readBroadcastDoc('flux-and-frameworks.md')
    const deployment = await readBroadcastDoc('deployment-and-scaling.md')
    const notifications = await readFile(resolve(root, 'apps/docs/docs/notifications/index.md'), 'utf8')

    expect(drivers).toContain('defineBroadcastConfig')
    expect(drivers).toContain('driver: \'holo\'')
    expect(drivers).toContain('driver: \'pusher\'')
    expect(drivers).toContain('driver: \'log\'')
    expect(drivers).toContain('driver: \'null\'')
    expect(drivers).not.toContain('driver: \'ably\'')
    expect(authoring).toContain('/broadcasting/auth')
    expect(authoring).toContain('privateChannel')
    expect(authoring).toContain('defineChannel')
    expect(flux).toContain('No manual client bootstrap is required')
    expect(flux).toContain('useFluxPublic(...)')
    expect(flux).toContain('useFluxPrivate(...)')
    expect(flux).toContain('useFluxPresence(...)')
    expect(flux).toContain('useFluxNotification(...)')
    expect(flux).toContain('useFluxConnectionStatus(...)')
    expect(deployment).toContain('Redis-backed coordination')
    expect(deployment).toContain('Pusher-compatible providers')
    expect(deployment).toContain('notifications on the built-in')
    expect(notifications).toContain('broadcast')
  })
})
