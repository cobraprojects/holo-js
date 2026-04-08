export interface HoloRuntimeConnection {
  driver?: 'sqlite' | 'postgres' | 'mysql'
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging: boolean
}

export interface HoloRuntimeDatabaseGroup {
  defaultConnection: string
  connections: Record<string, { url?: string } | HoloRuntimeConnection>
}

export interface HoloRuntimeDefaultConnection extends HoloRuntimeConnection {
  defaultConnection: 'default'
  connections: {
    default: HoloRuntimeConnection
  }
}

export declare function useHoloDb(): HoloRuntimeDatabaseGroup | HoloRuntimeDefaultConnection
export declare function useHoloEnv(): 'production' | 'development' | 'test'
export declare function useHoloDebug(): boolean
