import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export type LocalPackageRegistry = {
  readonly url: string
  readonly scope: string
  readonly env: { readonly BUN_INSTALL_CACHE_DIR: string }
  close(): Promise<void>
}

function sharedBunCacheDirectory(): string {
  return execFileSync('bun', ['pm', 'cache'], { encoding: 'utf8', timeout: 120_000 }).trim()
}

async function createScopeIsolatedBunCache(root: string, scope: string): Promise<string> {
  const cache = join(root, 'bun-cache')
  await mkdir(cache)
  const shared = sharedBunCacheDirectory()
  if (!existsSync(shared)) return cache
  for (const entry of readdirSync(shared).filter(entry => entry !== scope)) {
    await symlink(join(shared, entry), join(cache, entry))
  }
  return cache
}

export async function startLocalPackageRegistry(options: {
  readonly scope: string
  readonly catalog: Record<string, string>
  readonly packages: readonly { readonly name: string, readonly directory: string }[]
}): Promise<LocalPackageRegistry> {
  const root = await mkdtemp(join(tmpdir(), 'holo-local-registry-'))
  const configPath = join(root, 'registry.json')
  await writeFile(configPath, JSON.stringify({ catalog: options.catalog, packages: options.packages }))
  const bunCache = await createScopeIsolatedBunCache(root, options.scope)
  const server = spawn(process.execPath, [join(import.meta.dirname, 'local-package-registry-server.mjs'), configPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const firstLine = await new Promise<string>((resolve, reject) => {
    createInterface({ input: server.stdout }).once('line', resolve)
    server.once('exit', code => reject(new Error(`The local package registry exited before it was ready (code ${String(code)}).`)))
  })
  const { url } = JSON.parse(firstLine) as { url: string }

  return {
    url,
    scope: options.scope,
    env: { BUN_INSTALL_CACHE_DIR: bunCache },
    async close() {
      if (server.exitCode === null) {
        const stopped = once(server, 'exit')
        server.kill('SIGTERM')
        await stopped
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}
