import { DatabaseContext, createDatabase } from '../core/DatabaseContext'
import { ConfigurationError } from '../core/errors'
import type { DatabaseContextOptions } from '../core/types'

export interface ConnectionManagerOptions {
  defaultConnection: string
  connections: Record<string, DatabaseContext | DatabaseContextOptions>
}

export class ConnectionManager {
  private readonly defaultConnection: string
  private readonly definitions: Map<string, DatabaseContext | DatabaseContextOptions>
  private readonly resolved = new Map<string, DatabaseContext>()

  constructor(options: ConnectionManagerOptions) {
    if (!options.defaultConnection) {
      throw new ConfigurationError('ConnectionManager requires a defaultConnection.')
    }

    if (!options.connections[options.defaultConnection]) {
      throw new ConfigurationError(
        `ConnectionManager default connection "${options.defaultConnection}" is not defined.`,
      )
    }

    this.defaultConnection = options.defaultConnection
    this.definitions = new Map(Object.entries(options.connections))
  }

  getDefaultConnectionName(): string {
    return this.defaultConnection
  }

  getConnectionNames(): string[] {
    return [...this.definitions.keys()]
  }

  hasConnection(name: string): boolean {
    return this.definitions.has(name)
  }

  connection(name = this.defaultConnection): DatabaseContext {
    const cached = this.resolved.get(name)
    if (cached) return cached

    const definition = this.definitions.get(name)
    if (!definition) {
      throw new ConfigurationError(`Connection "${name}" is not defined.`)
    }

    const connection = definition instanceof DatabaseContext
      ? definition
      : createDatabase({ ...definition, connectionName: definition.connectionName ?? name })

    this.resolved.set(name, connection)
    return connection
  }

  async initializeAll(): Promise<void> {
    await Promise.all(this.getConnectionNames().map(name => this.connection(name).initialize()))
  }

  async disconnectAll(): Promise<void> {
    for (const connection of this.resolved.values()) {
      await connection.disconnect()
    }
  }

  async transaction<T>(
    callback: (connection: DatabaseContext) => Promise<T>,
    connectionName = this.defaultConnection,
  ): Promise<T> {
    return this.connection(connectionName).transaction(callback)
  }
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  return new ConnectionManager(options)
}
