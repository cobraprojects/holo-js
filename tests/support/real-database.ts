export type TestDriver = 'sqlite' | 'postgres' | 'mysql'

function integrationEnabled(driver: TestDriver): boolean {
  return driver === 'sqlite'
    || (driver === 'postgres' && process.env.HOLO_POSTGRES_INTEGRATION === '1')
    || (driver === 'mysql' && process.env.HOLO_MYSQL_INTEGRATION === '1')
}

export function integrationDrivers<const D extends TestDriver>(drivers: readonly D[]): D[] {
  return drivers.filter(integrationEnabled)
}

export const postgresIntegration = integrationEnabled('postgres')
export const mysqlIntegration = integrationEnabled('mysql')

const systemDatabases = new Set(['postgres', 'template0', 'template1', 'mysql', 'information_schema', 'performance_schema', 'sys'])

function scratchDatabase(flag: string, variable: string): string {
  if (process.env[flag] !== '1') {
    throw new Error(`Real database tests must be gated on ${flag}=1 before they connect.`)
  }
  const database = process.env[variable]
  if (!database || !/^\w+$/.test(database) || systemDatabases.has(database.toLowerCase())) {
    throw new Error(`${variable} must name a scratch test database made of letters, digits and underscores; real database tests never fall back to a default or system database.`)
  }
  return database
}

export function postgresTestConnection() {
  const database = scratchDatabase('HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE')
  return {
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
    password: process.env.HOLO_POSTGRES_PASSWORD,
    database,
  }
}

export function mysqlTestConnection() {
  const database = scratchDatabase('HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE')
  return {
    host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
    user: process.env.HOLO_MYSQL_USER ?? 'root',
    password: process.env.HOLO_MYSQL_PASSWORD ?? '',
    database,
  }
}

export function testConnectionUrl(scheme: 'postgresql' | 'mysql', connection: { host: string, port: number, user: string, password?: string, database: string }): URL {
  if (!/^[A-Za-z0-9.-]+$/.test(connection.host) || !Number.isInteger(connection.port)) {
    throw new Error(`The test database host ${JSON.stringify(connection.host)} and port ${connection.port} must be a plain host name and port.`)
  }
  const url = new URL(`${scheme}://${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`)
  url.username = encodeURIComponent(connection.user)
  if (connection.password) url.password = encodeURIComponent(connection.password)
  return url
}
