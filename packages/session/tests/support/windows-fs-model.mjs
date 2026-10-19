function permissionDenied(operation) {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

export function createWindowsFsModel(actual, options = {}) {
  const enabled = options.enabled ?? true
  const freshFileMs = options.freshFileMs ?? 0
  const failRate = options.failRate ?? 0

  const randomlyBusy = () => Math.random() < failRate

  async function isDirectory(path) {
    return await actual.stat(path).then(value => value.isDirectory(), () => false)
  }

  async function isFreshlyCreated(path) {
    if (freshFileMs <= 0) return false
    const stats = await actual.stat(path).catch(() => undefined)
    return stats !== undefined && Date.now() - stats.birthtimeMs < freshFileMs
  }

  return {
    async unlink(path, ...rest) {
      if (enabled && (await isFreshlyCreated(path) || randomlyBusy())) throw permissionDenied('unlink')
      return await actual.unlink(path, ...rest)
    },
    async rmdir(path, ...rest) {
      if (enabled && randomlyBusy()) throw permissionDenied('rmdir')
      return await actual.rmdir(path, ...rest)
    },
    async rename(source, target) {
      if (enabled && (await isDirectory(target) || randomlyBusy())) throw permissionDenied('rename')
      return await actual.rename(source, target)
    },
  }
}
