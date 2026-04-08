declare module 'pg' {
  export interface PoolConfig {
    connectionString?: string
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    ssl?: boolean | Record<string, unknown>
    [key: string]: unknown
  }

  export interface QueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
    rows: TRow[]
    rowCount?: number | null
  }

  export class Pool {
    constructor(config?: PoolConfig)
    connect(): Promise<{
      query(sql: string, bindings?: readonly unknown[]): Promise<QueryResult<Record<string, unknown>>>
      release?(): void
      end?(): Promise<void>
    }>
    end(): Promise<void>
    query(sql: string, bindings?: readonly unknown[]): Promise<QueryResult<Record<string, unknown>>>
  }
}
