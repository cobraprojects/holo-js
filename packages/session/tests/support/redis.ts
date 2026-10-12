import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { promisify } from 'node:util'
import Redis from 'ioredis'
import { onTestFinished } from 'vitest'

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
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
  const previousCertificates = getCACertificates('default')
  let certificate: string | undefined
  onTestFinished(async () => {
    clients.forEach(client => client.disconnect())
    if (options.tls) setDefaultCACertificates(previousCertificates)
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
    setDefaultCACertificates([...previousCertificates, certificate])
  }
  const executable = await redisExecutable()
  for (let index = 0; index < (options.cluster ? 3 : 1); index += 1) {
    const port = await availablePort()
    ports.push(port)
    const args = ['--bind', '127.0.0.1', '--port', String(options.tls ? 0 : port), '--save', '', '--appendonly', 'no', '--dir', root]
    if (options.tls) args.push('--tls-port', String(port), '--tls-cert-file', certificatePath, '--tls-key-file', privateKeyPath, '--tls-ca-cert-file', certificatePath, '--tls-auth-clients', 'no')
    if (options.cluster) {
      if (options.tls) args.push('--tls-cluster', 'yes')
      const busPort = await availablePort()
      busPorts.push(busPort)
      args.push('--cluster-enabled', 'yes', '--cluster-port', String(busPort), '--cluster-config-file', `node-${index}.conf`, '--cluster-node-timeout', '1000')
    } else {
      args.push('--unixsocket', socket)
    }
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    processes.push(child)
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => reject(new Error('Redis startup timed out')), 10_000)
      const output: string[] = []
      child.once('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timeout)
        reject(new Error(`Redis exited (${code}): ${output.join('')}`))
      })
      child.stdout?.on('data', (data: Buffer) => {
        output.push(data.toString())
        if (data.toString().includes('Ready to accept connections')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      child.stderr?.on('data', (data: Buffer) => output.push(data.toString()))
    })
    const client = new Redis({ host: '127.0.0.1', port, tls: options.tls ? { ca: certificate } : undefined, maxRetriesPerRequest: 1 })
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
