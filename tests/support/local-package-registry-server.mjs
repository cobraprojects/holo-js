import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveReleaseManifest } from '../../scripts/release-manifests.mjs'

const execute = promisify(execFile)

async function packPackage(directory, catalog, packRoot) {
  const manifest = resolveReleaseManifest(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')), catalog)
  const staging = await mkdtemp(join(packRoot, 'package-'))
  await cp(join(directory, 'dist'), join(staging, 'dist'), { recursive: true, dereference: true })
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2))
  const { stdout } = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', staging], { cwd: staging })
  const [packed] = JSON.parse(stdout)
  if (!packed) throw new Error(`npm pack produced no tarball for ${manifest.name}.`)
  return { manifest, tarball: await readFile(join(staging, packed.filename)) }
}

function tarballFileName(manifest) {
  return `${manifest.name.replace('/', '-')}-${manifest.version}.tgz`
}

function packument(registryUrl, { manifest, tarball }) {
  return {
    'name': manifest.name,
    'dist-tags': { latest: manifest.version },
    'versions': {
      [manifest.version]: {
        ...manifest,
        dist: {
          tarball: `${registryUrl}tarballs/${tarballFileName(manifest)}`,
          shasum: createHash('sha1').update(tarball).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
        },
      },
    },
  }
}

function sendNotFound(response) {
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"Not found"}')
}

const { catalog, packages } = JSON.parse(await readFile(process.argv[2], 'utf8'))
const packRoot = await mkdtemp(join(tmpdir(), 'holo-local-registry-'))
const packed = new Map()
const packedByTarball = new Map()
for (const result of await Promise.all(packages.map(({ directory }) => packPackage(directory, catalog, packRoot)))) {
  packed.set(result.manifest.name, result)
  packedByTarball.set(tarballFileName(result.manifest), result)
}

const runPath = `/${randomUUID()}/`
const server = createServer((request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://registry').pathname)
    if (!requestPath.startsWith(runPath)) return sendNotFound(response)
    const path = requestPath.slice(runPath.length - 1)
    if (path.startsWith('/tarballs/')) {
      const result = packedByTarball.get(path.slice('/tarballs/'.length))
      if (!result) return sendNotFound(response)
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': result.tarball.length })
      response.end(result.tarball)
      return
    }
    const result = packed.get(path.slice(1))
    if (!result) return sendNotFound(response)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(packument(url, result)))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}${runPath}`

async function shutdown() {
  server.closeAllConnections()
  server.close()
  await rm(packRoot, { recursive: true, force: true })
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
process.stdout.write(`${JSON.stringify({ url })}\n`)
