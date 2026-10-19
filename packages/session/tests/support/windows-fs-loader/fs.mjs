import * as actual from 'node:fs/promises'

const freshFileMs = Number(process.env.WINDOWS_FS_FRESH_MS ?? 0)
const failRate = Number(process.env.WINDOWS_FS_FAIL_RATE ?? 0)
const enabled = (process.argv[1] ?? '').endsWith('file-session-worker.mjs')

function permissionDenied(operation) {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

async function isDirectory(path) {
  return await actual.stat(path).then(value => value.isDirectory(), () => false)
}

async function isFreshlyCreated(path) {
  if (freshFileMs <= 0) return false
  const stats = await actual.stat(path).catch(() => undefined)
  return stats !== undefined && Date.now() - stats.birthtimeMs < freshFileMs
}

function randomlyBusy() {
  return Math.random() < failRate
}

export * from 'node:fs/promises'
export default actual

export async function unlink(path, ...rest) {
  if (enabled && (await isFreshlyCreated(path) || randomlyBusy())) throw permissionDenied('unlink')
  return await actual.unlink(path, ...rest)
}

export async function rmdir(path, ...rest) {
  if (enabled && randomlyBusy()) throw permissionDenied('rmdir')
  return await actual.rmdir(path, ...rest)
}

export async function rename(source, target) {
  if (enabled && (await isDirectory(target) || randomlyBusy())) throw permissionDenied('rename')
  return await actual.rename(source, target)
}
