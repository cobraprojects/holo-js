import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import * as tls from 'node:tls'
import { promisify } from 'node:util'
import Redis from 'ioredis'
import { onTestFinished } from 'vitest'

const redisClusterBusPortOffset = 10_000
const redisPortRange = { min: 10_000, max: 65_535 - redisClusterBusPortOffset }
const redisStartAttempts = 5
const redisPortProbeAttempts = 200

interface RedisNodePorts {
  readonly port: number
  readonly busPort: number
}

function listenOn(port: number): Promise<Server> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function reserveRedisNodePorts(cluster: boolean): Promise<RedisNodePorts> {
  for (let attempt = 0; attempt < redisPortProbeAttempts; attempt += 1) {
    const port = redisPortRange.min + Math.floor(Math.random() * (redisPortRange.max - redisPortRange.min + 1))
    const busPort = port + redisClusterBusPortOffset
    const held: Server[] = []
    try {
      held.push(await listenOn(port))
      if (cluster) held.push(await listenOn(busPort))
      return { port, busPort }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    } finally {
      await Promise.all(held.map(closeServer))
    }
  }
  throw new Error('Could not reserve free Redis ports')
}

const redisBindFailure = /Failed listening on port \d+|Address already in use/

function waitForRedisStart(child: ChildProcess): Promise<'ready' | 'bind-failed'> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error('Redis startup timed out')), 10_000)
    const output: string[] = []
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timeout)
      const text = output.join('')
      if (redisBindFailure.test(text)) return resolve('bind-failed')
      reject(new Error(`Redis exited (${code}): ${text}`))
    })
    child.stdout?.on('data', (data: Buffer) => {
      output.push(data.toString())
      if (data.toString().includes('Ready to accept connections')) {
        clearTimeout(timeout)
        resolve('ready')
      }
    })
    child.stderr?.on('data', (data: Buffer) => output.push(data.toString()))
  })
}

async function redisExecutable(): Promise<string> {
  if (process.env.HOLO_REDIS_SERVER) return process.env.HOLO_REDIS_SERVER
  const bundled = '/Users/Shared/DBngin/redis/7.0.0/bin/redis-server'
  try {
    await access(bundled)
    return bundled
  } catch {
    return 'redis-server'
  }
}

export const canTrustTestCertificates = typeof tls.setDefaultCACertificates === 'function'

async function startRedisNode(options: {
  readonly executable: string
  readonly root: string
  readonly socket: string
  readonly index: number
  readonly cluster?: boolean
  readonly tls?: boolean
  readonly certificatePath: string
  readonly privateKeyPath: string
  readonly processes: ChildProcess[]
}): Promise<RedisNodePorts> {
  for (let attempt = 1; ; attempt += 1) {
    const reserved = await reserveRedisNodePorts(options.cluster === true)
    const args = ['--bind', '127.0.0.1', '--port', String(options.tls ? 0 : reserved.port), '--save', '', '--appendonly', 'no', '--dir', options.root]
    if (options.tls) args.push('--tls-port', String(reserved.port), '--tls-cert-file', options.certificatePath, '--tls-key-file', options.privateKeyPath, '--tls-ca-cert-file', options.certificatePath, '--tls-auth-clients', 'no')
    if (options.cluster) {
      if (options.tls) args.push('--tls-cluster', 'yes')
      args.push('--cluster-enabled', 'yes', '--cluster-port', String(reserved.busPort), '--cluster-config-file', `node-${options.index}.conf`, '--cluster-node-timeout', '1000')
    } else {
      args.push('--unixsocket', options.socket)
    }
    const child = spawn(options.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    options.processes.push(child)
    if (await waitForRedisStart(child) === 'ready') return reserved
    if (attempt === redisStartAttempts) throw new Error(`Redis could not bind a free port after ${attempt} attempts`)
  }
}

export async function startRedisService(options: { cluster?: boolean; tls?: boolean } = {}): Promise<{
  readonly ports: readonly number[]
  readonly socket: string
  readonly clients: readonly Redis[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'holo-redis-'))
  const processes: ChildProcess[] = []
  const clients: Redis[] = []
  const ports: number[] = []
  const busPorts: number[] = []
  const socket = join(root, 'redis.sock')
  const certificatePath = join(root, 'certificate.pem')
  const privateKeyPath = join(root, 'private-key.pem')
  const previousCertificates = options.tls ? tls.getCACertificates('default') : []
  let certificate: string | undefined
  onTestFinished(async () => {
    clients.forEach(client => client.disconnect())
    if (options.tls) tls.setDefaultCACertificates(previousCertificates)
    await Promise.all(processes.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })))
    await rm(root, { recursive: true, force: true })
  })
  if (options.tls) {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKeyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'])
    certificate = await readFile(certificatePath, 'utf8')
    tls.setDefaultCACertificates([...previousCertificates, certificate])
  }
  const executable = await redisExecutable()
  for (let index = 0; index < (options.cluster ? 3 : 1); index += 1) {
    const node = await startRedisNode({ executable, root, socket, index, cluster: options.cluster, tls: options.tls, certificatePath, privateKeyPath, processes })
    ports.push(node.port)
    busPorts.push(node.busPort)
    const client = new Redis({ host: '127.0.0.1', port: node.port, tls: options.tls ? { ca: certificate } : undefined, maxRetriesPerRequest: 1 })
    clients.push(client)
    await client.ping()
  }
  if (options.cluster) {
    await Promise.all(clients.map(async (client, index) => {
      const start = Math.floor(index * 16384 / clients.length)
      const end = Math.floor((index + 1) * 16384 / clients.length) - 1
      await client.cluster('ADDSLOTSRANGE', start, end)
      for (const [node, port] of ports.entries()) {
        const busPort = busPorts[node]
        if (!busPort) throw new Error('Expected Redis cluster bus port')
        await client.call('CLUSTER', 'MEET', '127.0.0.1', port, busPort)
      }
    }))
    const deadline = Date.now() + 10_000
    while (!(await Promise.all(clients.map(client => client.cluster('INFO')))).every(info => typeof info === 'string' && info.includes('cluster_state:ok'))) {
      if (Date.now() > deadline) throw new Error('Redis cluster did not become ready')
      await setTimeout(50)
    }
  }
  return { ports, socket, clients }
}
