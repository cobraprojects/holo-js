import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createCapabilities,
  createDatabase,
  configureDB,
  createConnectionManager,
  resetDatabaseDependencyInvalidationListeners,
  resetDB,
  belongsToMany,
  column,
  defineGeneratedTable,
  defineModel,
  type DatabaseContext,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'
import { field, schema } from '@holo-js/validation'
import {
  configureRealtimeClientTransport,
  createRealtimeClient,
  defineRealtimeMutation,
  defineRealtimeQuery,
  isRealtimeDefinition,
  resetRealtimeClientRuntime,
} from '../src/index'
import {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
  resolveRealtimeDefinition,
  subscribeRealtimeQuery,
} from '../src/server'
import type { AuthenticatedAuthUser } from '@holo-js/auth'
import type { RealtimeAuthModule } from '../src/index'

type MemoryRow = Record<string, unknown>
type MemoryTables = Record<string, MemoryRow[]>

class MemoryAdapter implements DriverAdapter {
  private connected = false
  readonly rows: Record<string, unknown>[] = [
    { id: 1, title: 'First' },
  ]

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> {
    return {
      rows: this.rows.map(row => ({ ...row })) as TRow[],
      rowCount: this.rows.length,
    }
  }

  async execute(): Promise<DriverExecutionResult> {
    this.rows.push({
      id: this.rows.length + 1,
      title: `Post ${this.rows.length + 1}`,
    })

    return {
      affectedRows: 1,
      lastInsertId: this.rows.length,
    }
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

function readPlaceholderIndexes(rawPlaceholders: string): number[] {
  return rawPlaceholders.split(', ').map((part, index) => {
    const rawIndex = part.replace('?', '')
    return rawIndex ? Number(rawIndex) - 1 : index
  })
}

function filterMemoryRows(sql: string, bindings: readonly unknown[], rows: readonly MemoryRow[]): MemoryRow[] {
  const whereMatch = sql.match(/ WHERE (.+?)( ORDER BY| LIMIT| OFFSET|$)/)
  if (!whereMatch) {
    return [...rows]
  }

  const clauses = whereMatch[1]!.split(' AND ')
  return rows.filter(row => clauses.every((clause) => {
    const inMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)" IN \((.+)\)$/)
    if (inMatch) {
      const [, column, rawPlaceholders] = inMatch
      return readPlaceholderIndexes(rawPlaceholders!).map(index => bindings[index]).includes(row[column!])
    }

    const equalMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)" = \?(\d+)$/)
    if (equalMatch) {
      const [, column, index] = equalMatch
      return row[column!] === bindings[Number(index) - 1]
    }

    return true
  }))
}

class RelationalMemoryAdapter implements DriverAdapter {
  private connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []

  constructor(readonly tables: MemoryTables) {}

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    this.queries.push({ sql, bindings })
    const tableName = sql.match(/ FROM "([^"]+)"/)?.[1] ?? ''
    let rows = filterMemoryRows(sql, bindings, this.tables[tableName] ?? [])

    const orderMatch = sql.match(/ ORDER BY "([^"]+)" (ASC|DESC)/)
    if (orderMatch) {
      const [, column, direction] = orderMatch
      rows = [...rows].sort((left, right) => {
        const leftValue = left[column!]
        const rightValue = right[column!]
        if (leftValue === rightValue) {
          return 0
        }

        const ascending = leftValue! < rightValue! ? -1 : 1
        return direction === 'ASC' ? ascending : -ascending
      })
    }

    const limitMatch = sql.match(/ LIMIT \?(\d+)/)
    const offsetMatch = sql.match(/ OFFSET \?(\d+)/)
    const offset = offsetMatch ? Number(bindings[Number(offsetMatch[1]) - 1]) : 0
    const limit = limitMatch ? Number(bindings[Number(limitMatch[1]) - 1]) : undefined
    const pagedRows = typeof limit === 'number'
      ? rows.slice(offset, offset + limit)
      : rows.slice(offset)

    return {
      rows: pagedRows.map(row => ({ ...row })) as TRow[],
      rowCount: pagedRows.length,
    }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })
    const insertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+)$/)
    if (!insertMatch) {
      return { affectedRows: 0 }
    }

    const [, tableName, rawColumns, rawValues] = insertMatch
    const columns = rawColumns!.split(', ').map(part => part.replaceAll('"', ''))
    const groups = [...rawValues!.matchAll(/\(([^)]+)\)/g)]
    const table = this.tables[tableName!] ?? (this.tables[tableName!] = [])

    for (const group of groups) {
      const placeholders = group[1]!.split(', ')
      const row: MemoryRow = {}
      for (let index = 0; index < columns.length; index += 1) {
        const rawIndex = placeholders[index]!.replace('?', '')
        const bindingIndex = rawIndex ? Number(rawIndex) - 1 : index
        row[columns[index]!] = bindings[bindingIndex]
      }
      if (!Object.prototype.hasOwnProperty.call(row, 'id')) {
        row.id = table.reduce((max, current) => Math.max(max, Number(current.id ?? 0)), 0) + 1
      }
      table.push(row)
    }

    return {
      affectedRows: groups.length,
      lastInsertId: table.at(-1)?.id as number | string | undefined,
    }
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

const dialect: Dialect = {
  name: 'sqlite',
  capabilities: createCapabilities(),
  quoteIdentifier(identifier: string): string {
    return `"${identifier}"`
  },
  createPlaceholder(): string {
    return '?'
  },
}

function createContext(adapter: DriverAdapter = new MemoryAdapter()): DatabaseContext {
  return createDatabase({
    adapter,
    dialect,
    connectionName: 'main',
  })
}

function createAuthModule(users: Readonly<Record<string, AuthenticatedAuthUser | null>>): RealtimeAuthModule {
  return {
    getAuthRuntime() {
      return {
        user: async () => users.default ?? null,
        provider: async () => users.default ? 'local' : null,
        guard(name: string) {
          return {
            user: async () => users[name] ?? null,
            provider: async () => users[name] ? 'local' : null,
          }
        },
      }
    },
  }
}

afterEach(() => {
  resetRealtimeClientRuntime()
  resetRealtimeRuntime()
  resetDatabaseDependencyInvalidationListeners()
  resetDB()
})

describe('@holo-js/realtime', () => {
  it('executes public queries with validated args and auto-generated names', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      args: schema({
        limit: field.number().integer(),
      }),
      access: 'public',
      handler: async ({ args, auth, db: context }) => {
        expect(auth).toBeNull()
        expect(args.limit).toBe(10)
        return context.table('posts').limit(args.limit).get()
      },
    })

    const result = await executeRealtimeQuery(query, { limit: 10 })

    expect(result.name).toMatch(/^realtime\.query\.\d+$/)
    expect(result.data).toEqual([{ id: 1, title: 'First' }])
    expect(result.dependencies).toEqual(['db:main:posts'])
  })

  it('uses the configured DB facade when no realtime database binding is provided', async () => {
    const db = createContext()
    configureDB({
      connection: () => db,
    } as never)
    configureRealtimeRuntime({
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
    })
  })

  it('allows public queries when auth is installed but not configured', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('treats configured anonymous auth as optional for public queries', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: null,
      }),
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('exposes model repositories through the realtime db context', async () => {
    const repository = { name: 'PostRepository' }
    const connection = {
      model: () => repository,
    } as unknown as DatabaseContext
    const context = realtimeRuntimeInternals.createRealtimeDatabaseContext(connection)

    expect(context.connection).toBe(connection)
    expect(context.model({} as never)).toBe(repository)
  })

  it('honors custom definition names', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      name: 'posts.list',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      name: 'posts.list',
    })
  })

  it('executes callable query and mutation definitions directly on the server', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      args: schema({
        limit: field.number().integer(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        const rows = await context.table('posts').limit(args.limit).get()

        return {
          rows,
          limit: args.limit,
        }
      },
    })
    const createPost = defineRealtimeMutation({
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        await context.table('posts').insert({ title: args.title })

        return {
          created: args.title,
        }
      },
    })

    await expect(listPosts({ limit: 1 })).resolves.toEqual({
      rows: [{ id: 1, title: 'First' }],
      limit: 1,
    })
    await expect(createPost({ title: 'Second' })).resolves.toEqual({
      created: 'Second',
    })
    await expect(listPosts({ limit: 2 })).resolves.toEqual({
      rows: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
      limit: 2,
    })
  })

  it('persists mutation database writes without a broadcast worker or client transport', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').orderBy('id').get(),
    })
    const renamePost = defineRealtimeMutation({
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        await context.table('posts').insert({ title: args.title })

        return await context.table('posts').orderBy('id').get()
      },
    })

    await expect(renamePost({ title: 'Worker independent' })).resolves.toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Worker independent' },
    ])
    await expect(listPosts()).resolves.toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Worker independent' },
    ])
    expect(adapter.executions).toHaveLength(1)
    expect(adapter.executions[0]?.sql).toContain('INSERT INTO "posts"')
  })

  it('identifies realtime definitions and rejects invalid access guard configuration', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async () => true,
    })
    const conflictingGuards = defineRealtimeQuery({
      access: {
        require: 'public',
        guard: 'web',
        guards: ['admin'],
      },
      handler: async () => true,
    })
    const emptyGuards = defineRealtimeQuery({
      access: {
        require: 'public',
        guards: [],
      },
      handler: async () => true,
    })

    expect(isRealtimeDefinition(query)).toBe(true)
    expect(isRealtimeDefinition({})).toBe(false)
    await expect(executeRealtimeQuery(conflictingGuards)).rejects.toBeInstanceOf(RealtimeError)
    await expect(executeRealtimeQuery(emptyGuards)).rejects.toBeInstanceOf(RealtimeError)
  })

  it('refreshes subscribed queries after direct Holo DB writes invalidate matching dependencies', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { ok: true }
      },
    })

    const subscription = await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(mutation)

    expect(subscription.current.data).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
    ])
  })

  it('coalesces duplicate subscription refreshes by query key during invalidation bursts', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    let blockNextRefresh = false
    let releaseRefresh = () => {}
    let resolveRefreshStarted = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      resolveRefreshStarted = resolve
    })
    const firstSnapshots: unknown[][] = []
    const secondSnapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context.table('posts').get()
        if (blockNextRefresh) {
          blockNextRefresh = false
          resolveRefreshStarted()
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve
          })
        }

        return rows
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        firstSnapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        secondSnapshots.push(snapshot.data)
      },
    })

    expect(queryRuns).toBe(2)

    blockNextRefresh = true
    const firstInvalidation = realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await refreshStarted

    const burstInvalidations = Array.from({ length: 5 }, async () => await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    }))
    releaseRefresh()
    await Promise.all([firstInvalidation, ...burstInvalidations])

    expect(queryRuns).toBe(4)
    expect(firstSnapshots).toHaveLength(3)
    expect(secondSnapshots).toHaveLength(3)
    expect(firstSnapshots).toEqual(secondSnapshots)
  })

  it('isolates user subscription callback failures while refreshing matching subscriptions', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldFailQuery = false
    let shouldFailOnData = false
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const failingQuery = defineRealtimeQuery({
      name: 'posts.failing',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').get()
        if (shouldFailQuery) {
          throw new Error('query failed')
        }

        return []
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { ok: true }
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: () => {
        if (shouldFailOnData) {
          throw new Error('onData failed')
        }
      },
    })
    await subscribeRealtimeQuery(failingQuery, {}, {
      onError: () => {
        throw new Error('onError failed')
      },
    })
    shouldFailQuery = true
    shouldFailOnData = true

    await expect(executeRealtimeMutation(mutation)).resolves.toMatchObject({
      data: { ok: true },
    })

    expect(snapshots.at(-1)).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(consoleError).toHaveBeenCalledWith(
      '[@holo-js/realtime] Realtime subscription onData callback failed.',
      expect.any(Error),
    )
    expect(consoleError).toHaveBeenCalledWith(
      '[@holo-js/realtime] Realtime subscription onError callback failed.',
      expect.any(Error),
    )
  })

  it('refreshes subscribed relation queries when related rows are attached', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const tags = defineGeneratedTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const postTags = defineGeneratedTable('post_tags', {
      id: column.id(),
      postId: column.integer(),
      tagId: column.integer(),
    })
    const Tag = defineModel(tags)
    const Post = defineModel(posts, {
      relations: {
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId'),
      },
    })
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.model(Post).query().with('tags').orderBy('id').get(),
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('tags').insert({ id: 11, name: 'New' })
        await context.table('post_tags').insert({ postId: 1, tagId: 11 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(snapshots.at(-1)).toEqual([
      {
        id: 1,
        title: 'First',
        tags: [
          {
            id: 10,
            name: 'Existing',
            pivot: {
              postId: 1,
              tagId: 10,
            },
          },
          {
            id: 11,
            name: 'New',
            pivot: {
              postId: 1,
              tagId: 11,
            },
          },
        ],
      },
    ])
  })

  it('refreshes subscribed paginated queries after inserts change the current window', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').orderBy('id', 'desc').paginate(2, 1),
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
  })

  it('keeps subscribed cursor-paginated query windows anchored after earlier inserts', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: Array<{
      readonly ids: readonly number[]
      readonly cursorName: string
      readonly hasMorePages: boolean
    }> = []
    const firstPageQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const query = defineRealtimeQuery({
      args: schema({
        cursor: field.string().nullable(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2, args.cursor)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 5, title: 'Fifth' })
        return true
      },
    })
    const firstPage = await executeRealtimeQuery(firstPageQuery)

    await subscribeRealtimeQuery(query, { cursor: firstPage.data.nextCursor }, {
      onData: snapshot => {
        snapshots.push({
          ids: snapshot.data.data.map(post => Number(post.id)),
          cursorName: snapshot.data.cursorName,
          hasMorePages: snapshot.data.nextCursor !== null,
        })
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(snapshots).toEqual([
      {
        ids: [2, 1],
        cursorName: 'cursor',
        hasMorePages: false,
      },
      {
        ids: [2, 1],
        cursorName: 'cursor',
        hasMorePages: false,
      },
    ])
  })

  it('refreshes subscribed aggregate queries after writes change aggregate values', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => ({
        count: await context.table('posts').count(),
        views: await context.table('posts').sum('views'),
      }),
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third', views: 11 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(snapshots).toEqual([
      { count: 2, views: 12 },
      { count: 3, views: 23 },
    ])
  })

  it('supports client helpers and unsubscribes from later refreshes', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const client = createRealtimeClient()
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { count: adapter.rows.length }
      },
    })

    await expect(client.query(query, {})).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
    })
    const subscription = await client.subscribe(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await expect(client.mutate(mutation, {})).resolves.toMatchObject({
      data: { count: 2 },
    })
    subscription.unsubscribe()
    await client.mutate(mutation, {})

    expect(subscription.current.data).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
    ])
  })

  it('executes callable mutations through the client transport with inferred data', async () => {
    const createPost = defineRealtimeMutation({
      name: 'posts.create',
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args }) => ({
        id: 1,
        title: args.title,
      }),
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.list',
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>(name: string, args: Record<string, unknown>) {
        return {
          name,
          data: {
            id: 1,
            title: args.title,
          } as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {}
      },
    })

    await expect(createPost({ title: 'First' })).resolves.toEqual({
      id: 1,
      title: 'First',
    })
  })

  it('ignores unrelated dependency invalidations and reports refresh errors', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[][] = []
    const errors: unknown[] = []
    let shouldThrow = false
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        const rows = await context.table('posts').get()
        if (shouldThrow) {
          throw new Error('refresh failed')
        }

        return rows
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        errors.push(error)
      },
    })

    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:comments'],
    })
    shouldThrow = true
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })

    expect(snapshots).toEqual([[{ id: 1, title: 'First' }]])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  it('rejects authenticated access when auth is unavailable', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('rejects authenticated access when auth runtime loading fails', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => {
        throw new Error('auth crashed')
      },
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('rejects authenticated access when configured auth fails while resolving a guard', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => ({
        getAuthRuntime() {
          return {
            user: async () => {
              throw new Error('auth context missing')
            },
            provider: async () => null,
            guard() {
              return {
                user: async () => null,
                provider: async () => null,
              }
            },
          }
        },
      }),
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('treats failing optional auth as anonymous for public access', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => {
        throw new Error('auth crashed')
      },
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('resolves authenticated access across configured guards', async () => {
    const db = createContext()
    const user = {
      id: 10,
      email: 'ava@example.com',
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        admin: null,
        web: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        guards: ['admin', 'web'],
      },
      handler: async ({ auth }) => ({
        guard: auth.guard,
        userId: auth.user.id,
      }),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: {
        guard: 'web',
        userId: 10,
      },
    })
  })

  it('resolves authenticated access from one named guard', async () => {
    const db = createContext()
    const user = {
      id: 11,
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        web: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        guard: 'web',
      },
      handler: async ({ auth }) => auth.guard,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'web',
    })
  })

  it('runs custom authorization before the handler', async () => {
    const db = createContext()
    const user = {
      id: 10,
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        authorize: async ({ auth }) => auth?.user.id === 20,
      },
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeForbiddenError)
  })

  it('runs handlers when custom authorization allows access', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'public',
        authorize: async () => true,
      },
      handler: async () => 'allowed',
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'allowed',
    })
  })

  it('passes nullable auth into public custom authorization callbacks', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let receivedAuth: unknown = Symbol('unset')
    const query = defineRealtimeQuery({
      access: {
        require: 'public',
        authorize: async ({ auth }) => {
          receivedAuth = auth
          return true
        },
      },
      handler: async () => 'allowed',
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'allowed',
    })
    expect(receivedAuth).toBeNull()
  })

  it('only treats missing realtime definition directories as empty', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-server-'))

    try {
      await expect(resolveRealtimeDefinition('posts.missing', {
        projectRoot,
      })).rejects.toThrow('Realtime definition "posts.missing" was not found.')

      const filePath = join(projectRoot, 'server-realtime-file')
      await writeFile(filePath, '')
      await expect(resolveRealtimeDefinition('posts.missing', {
        projectRoot,
        realtimeRoot: 'server-realtime-file',
      })).rejects.toThrow()
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects custom authenticated authorization when no guard returns a user', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: null,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        authorize: async () => true,
      },
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeUnauthorizedError)
  })
})
