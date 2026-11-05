export const exampleAppDrivers = ['sqlite', 'postgres', 'mysql']

export function exampleAppConnections(driver) {
  if (!exampleAppDrivers.includes(driver)) throw new Error(`Unknown example app database driver: ${driver}. Expected one of ${exampleAppDrivers.join(', ')}.`)
  return [...new Set(['sqlite', driver])]
}

export function exampleAppServerProvisioning(driver, servers) {
  const selected = exampleAppConnections(driver).filter(name => servers[name]).map(name => servers[name])
  const attempted = []
  return {
    async create() {
      for (const server of selected) {
        attempted.push(server)
        await server.create()
      }
    },
    cleanups: () => attempted.map(server => server.drop),
  }
}
