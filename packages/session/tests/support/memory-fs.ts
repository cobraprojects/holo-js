import { constants } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

type MemoryNode = {
  readonly kind: 'file' | 'directory'
  readonly ino: number
  readonly birthtimeMs: number
  mtimeMs: number
  data: string
}

type MemoryFsOperation = 'mkdir' | 'open' | 'readFile' | 'readdir' | 'rename' | 'rm' | 'rmdir' | 'stat' | 'unlink' | 'utimes' | 'writeFile'

type MemoryFsHook = (operation: MemoryFsOperation, path: string) => void | Promise<void>

export type MemoryFs = ReturnType<typeof createMemoryFs>

function fsError(code: string, operation: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${operation} '${path}'`), { code, path })
}

function toMilliseconds(time: Date | number | string): number {
  if (time instanceof Date) return time.getTime()
  return Number(time) * 1_000
}

export function createMemoryFs(options: { readonly platform: 'posix' | 'win32' }) {
  const nodes = new Map<string, MemoryNode>()
  const hooks: MemoryFsHook[] = []
  let nextInode = 1

  function create(path: string, kind: MemoryNode['kind'], data = ''): void {
    const now = Date.now()
    nodes.set(path, { kind, ino: nextInode++, birthtimeMs: now, mtimeMs: now, data })
  }

  function children(path: string): string[] {
    return [...nodes.keys()].filter(candidate => candidate !== path && dirname(candidate) === path).sort()
  }

  function existing(path: string, operation: string): MemoryNode {
    const node = nodes.get(path)
    if (!node) throw fsError('ENOENT', operation, path)
    return node
  }

  function requireParent(path: string, operation: string): void {
    const parent = dirname(path)
    if (dirname(parent) !== parent && nodes.get(parent)?.kind !== 'directory') throw fsError('ENOENT', operation, path)
  }

  async function run(operation: MemoryFsOperation, path: string): Promise<void> {
    for (const hook of hooks) await hook(operation, path)
  }

  function statsFor(node: MemoryNode) {
    return {
      dev: 1,
      ino: node.ino,
      size: Buffer.byteLength(node.data),
      mtimeMs: node.mtimeMs,
      birthtimeMs: node.birthtimeMs,
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'directory',
    }
  }

  function readNode(path: string, operation: string): string {
    const node = existing(path, operation)
    if (node.kind === 'directory') throw fsError('EISDIR', operation, path)
    return node.data
  }

  function writeNode(path: string, data: string, flag: string, operation: string): void {
    const node = nodes.get(path)
    if (node?.kind === 'directory') throw fsError('EISDIR', operation, path)
    if (flag.includes('x') && node) throw fsError('EEXIST', operation, path)
    if (flag.startsWith('r') && !node) throw fsError('ENOENT', operation, path)
    if (!node) {
      requireParent(path, operation)
      create(path, 'file', data)
      return
    }
    node.data = data
    node.mtimeMs = Date.now()
  }

  function removeTree(path: string): void {
    for (const candidate of [...nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`) || candidate.startsWith(`${path}\\`)) nodes.delete(candidate)
    }
  }

  function moveTree(source: string, target: string): void {
    for (const [candidate, node] of [...nodes]) {
      if (candidate !== source && !candidate.startsWith(`${source}/`) && !candidate.startsWith(`${source}\\`)) continue
      nodes.delete(candidate)
      nodes.set(`${target}${candidate.slice(source.length)}`, node)
    }
  }

  const promises = {
    async mkdir(path: string, mkdirOptions?: { readonly recursive?: boolean }): Promise<string | undefined> {
      const target = resolve(path)
      await run('mkdir', target)
      if (mkdirOptions?.recursive) {
        const missing: string[] = []
        for (let current = target; !nodes.has(current) && dirname(current) !== current; current = dirname(current)) missing.unshift(current)
        if (nodes.get(dirname(missing[0] ?? target))?.kind === 'file') throw fsError('ENOTDIR', 'mkdir', target)
        for (const directory of missing) create(directory, 'directory')
        return missing[0]
      }
      if (nodes.has(target)) throw fsError('EEXIST', 'mkdir', target)
      requireParent(target, 'mkdir')
      create(target, 'directory')
      return undefined
    },
    async open(path: string, flags: string | number) {
      const target = resolve(path)
      await run('open', target)
      if (typeof flags === 'number') {
        if ((flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0) throw new Error('The memory fs only opens numeric flags for reading')
        readNode(target, 'open')
      } else if (flags === 'wx') {
        writeNode(target, '', 'wx', 'open')
      } else {
        throw new Error(`The memory fs does not support open flags "${flags}"`)
      }
      return {
        readFile: async () => readNode(target, 'read'),
        writeFile: async (data: string) => { writeNode(target, data, 'r+', 'write') },
        close: async () => undefined,
      }
    },
    async readFile(path: string): Promise<string> {
      const target = resolve(path)
      await run('readFile', target)
      return readNode(target, 'open')
    },
    async writeFile(path: string, data: string, writeOptions?: { readonly flag?: string }): Promise<void> {
      const target = resolve(path)
      await run('writeFile', target)
      writeNode(target, data, writeOptions?.flag ?? 'w', 'open')
    },
    async readdir(path: string): Promise<string[]> {
      const target = resolve(path)
      await run('readdir', target)
      if (existing(target, 'scandir').kind !== 'directory') throw fsError('ENOTDIR', 'scandir', target)
      return children(target).map(child => basename(child))
    },
    async opendir(path: string) {
      const entries = await promises.readdir(path)
      const target = resolve(path)
      return {
        read: async () => {
          const name = entries.shift()
          if (name === undefined) return null
          const kind = nodes.get(resolve(target, name))?.kind
          return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'directory' }
        },
        close: async () => undefined,
      }
    },
    async stat(path: string) {
      const target = resolve(path)
      await run('stat', target)
      return statsFor(existing(target, 'stat'))
    },
    async lstat(path: string) {
      return await promises.stat(path)
    },
    async utimes(path: string, _accessed: Date | number | string, modified: Date | number | string): Promise<void> {
      const target = resolve(path)
      await run('utimes', target)
      existing(target, 'utime').mtimeMs = toMilliseconds(modified)
    },
    async rename(source: string, target: string): Promise<void> {
      const from = resolve(source)
      const to = resolve(target)
      await run('rename', from)
      const node = existing(from, 'rename')
      requireParent(to, 'rename')
      const replaced = nodes.get(to)
      if (replaced && from !== to) {
        if (node.kind === 'directory' && options.platform === 'win32') throw fsError('EPERM', 'rename', from)
        if (node.kind === 'directory' && replaced.kind === 'file') throw fsError('ENOTDIR', 'rename', from)
        if (node.kind === 'file' && replaced.kind === 'directory') throw fsError(options.platform === 'win32' ? 'EPERM' : 'EISDIR', 'rename', from)
        if (replaced.kind === 'directory' && children(to).length > 0) throw fsError('ENOTEMPTY', 'rename', from)
        removeTree(to)
      }
      moveTree(from, to)
    },
    async rm(path: string, rmOptions?: { readonly force?: boolean, readonly recursive?: boolean }): Promise<void> {
      const target = resolve(path)
      await run('rm', target)
      const node = nodes.get(target)
      if (!node) {
        if (rmOptions?.force) return
        throw fsError('ENOENT', 'rm', target)
      }
      if (node.kind === 'directory' && !rmOptions?.recursive) throw fsError('ERR_FS_EISDIR', 'rm', target)
      removeTree(target)
    },
    async rmdir(path: string): Promise<void> {
      const target = resolve(path)
      await run('rmdir', target)
      if (existing(target, 'rmdir').kind !== 'directory') throw fsError('ENOTDIR', 'rmdir', target)
      if (children(target).length > 0) throw fsError('ENOTEMPTY', 'rmdir', target)
      nodes.delete(target)
    },
    async unlink(path: string): Promise<void> {
      const target = resolve(path)
      await run('unlink', target)
      if (existing(target, 'unlink').kind === 'directory') throw fsError(options.platform === 'win32' ? 'EPERM' : 'EISDIR', 'unlink', target)
      nodes.delete(target)
    },
  }

  return {
    promises,
    addHook(hook: MemoryFsHook): void {
      hooks.push(hook)
    },
    names(directory: string): string[] {
      return children(resolve(directory)).map(child => basename(child))
    },
  }
}

export function busyError(operation: string, path: string): NodeJS.ErrnoException {
  return fsError('EPERM', operation, path)
}

export function memoryFsModule(current: () => MemoryFs | undefined): MemoryFs['promises'] {
  const installed = (): MemoryFs['promises'] => {
    const fs = current()
    if (!fs) throw new Error('Install a memory fs before touching the filesystem')
    return fs.promises
  }
  const operations = Object.keys(createMemoryFs({ platform: 'posix' }).promises) as Array<keyof MemoryFs['promises']>
  return Object.fromEntries(operations.map(name => [name, (...args: unknown[]) => (installed()[name] as (...values: unknown[]) => unknown)(...args)])) as MemoryFs['promises']
}
