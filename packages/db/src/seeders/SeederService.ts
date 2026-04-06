import { connectionAsyncContext } from '../concurrency/AsyncConnectionContext'
import { DatabaseError, SecurityError } from '../core/errors'
import { withoutModelEvents } from '../model/eventState'
import { createSchemaService } from '../schema/SchemaService'
import { defineSeeder } from './defineSeeder'
import type { SeederStartLog } from '../core/types'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SeedOptions, SeederContext, SeederDefinition } from './types'

type SeederRunOptions = {
  quietly: boolean
  force: boolean
  environment?: string
}

export class SeederService {
  private readonly seeders = new Map<string, SeederDefinition>()

  constructor(
    private readonly connection: DatabaseContext,
    seeders: readonly SeederDefinition[] = [],
  ) {
    for (const seeder of seeders) {
      this.register(seeder)
    }
  }

  register(seeder: SeederDefinition): this {
    if (this.seeders.has(seeder.name)) {
      throw new DatabaseError(`Seeder "${seeder.name}" is already registered.`, 'DUPLICATE_SEEDER')
    }

    this.seeders.set(seeder.name, defineSeeder(seeder))
    return this
  }

  getSeeders(): readonly SeederDefinition[] {
    return [...this.seeders.values()]
  }

  getSeeder(name: string): SeederDefinition | undefined {
    return this.seeders.get(name)
  }

  async seed(options: SeedOptions = {}): Promise<SeederDefinition[]> {
    return this.runSeeders(this.selectSeeders(options.only), {
      quietly: options.quietly === true,
      force: options.force === true,
      environment: options.environment,
    })
  }

  private selectSeeders(only?: readonly string[]): readonly SeederDefinition[] {
    if (!only || only.length === 0) {
      return this.getSeeders()
    }

    for (const name of only) {
      if (!this.seeders.has(name)) {
        throw new DatabaseError(`Seeder "${name}" is not registered.`, 'UNKNOWN_SEEDER')
      }
    }

    const names = new Set(only)
    return this.getSeeders().filter(seeder => names.has(seeder.name))
  }

  private async runSeeders(
    seeders: readonly SeederDefinition[],
    options: SeederRunOptions,
    connection: DatabaseContext = this.connection,
  ): Promise<SeederDefinition[]> {
    this.assertCanSeed(options)
    const executed: SeederDefinition[] = []

    for (const seeder of seeders) {
      const log = this.createSeederLog(seeder.name, options)
      const startedAt = Date.now()

      await this.connection.getLogger()?.onSeederStart?.(log)

      try {
        const runSeeder = async (tx: DatabaseContext) => {
          const context = this.createContext(tx, options)
          const run = () => connectionAsyncContext.run({
            connectionName: tx.getConnectionName(),
            connection: tx,
          }, () => Promise.resolve(seeder.run(context)))

          if (options.quietly) {
            await withoutModelEvents(run)
          } else {
            await run()
          }
        }

        if (connection.getScope().kind === 'root') {
          await connection.transaction(async (tx) => {
            await runSeeder(tx)
          })
        } else {
          await runSeeder(connection)
        }

        await this.connection.getLogger()?.onSeederSuccess?.({
          ...log,
          durationMs: Date.now() - startedAt,
        })
      } catch (error) {
        await this.connection.getLogger()?.onSeederError?.({
          ...log,
          durationMs: Date.now() - startedAt,
          error,
        })
        throw error
      }

      executed.push(seeder)
    }

    return executed
  }

  private createContext(connection: DatabaseContext, options: SeederRunOptions): SeederContext {
    return {
      db: connection,
      schema: createSchemaService(connection),
      call: (...names) => this.runSeeders(this.selectSeeders(names), options, connection),
    }
  }

  private assertCanSeed(options: SeederRunOptions): void {
    if (options.environment === 'production' && !options.force) {
      throw new SecurityError(
        'Seeding in production requires force: true.',
      )
    }
  }

  private createSeederLog(name: string, options: SeederRunOptions): SeederStartLog {
    return {
      connectionName: this.connection.getConnectionName(),
      seederName: name,
      quietly: options.quietly,
      environment: options.environment,
    }
  }
}

export function createSeederService(
  connection: DatabaseContext,
  seeders: readonly SeederDefinition[] = [],
): SeederService {
  return new SeederService(connection, seeders)
}
