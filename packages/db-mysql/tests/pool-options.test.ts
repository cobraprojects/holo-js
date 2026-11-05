import type { PoolOptions } from 'mysql2/promise'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createPool = vi.hoisted(() => vi.fn())

vi.mock('mysql2/promise', () => ({
  default: { createPool },
}))

const { createMySQLAdapter } = await import('../src')

type TypeCastField = Parameters<Exclude<NonNullable<PoolOptions['typeCast']>, boolean>>[0]

async function poolOptions(config: PoolOptions): Promise<PoolOptions> {
  await createMySQLAdapter({ config }).initialize()
  return createPool.mock.lastCall![0] as PoolOptions
}

function field(overrides: Partial<TypeCastField> & { text: string | null, encoding?: string }): TypeCastField {
  const { text, encoding: expected = 'utf8', ...rest } = overrides
  return {
    type: 'LONG_BLOB',
    length: 0,
    db: 'app',
    table: 'posts',
    name: 'payload',
    string: (encoding?: string) => (encoding === undefined || encoding === expected ? text : 'wrong-encoding'),
    buffer: () => null,
    geometry: () => null,
    ...rest,
  } as unknown as TypeCastField
}

function readField(options: PoolOptions, value: TypeCastField): unknown {
  const typeCast = options.typeCast as Exclude<NonNullable<PoolOptions['typeCast']>, boolean>
  return typeCast(value, () => 'driver')
}

describe('@holo-js/db-mysql pool options', () => {
  beforeEach(() => {
    createPool.mockReset()
    createPool.mockReturnValue({ pool: { on: vi.fn() }, query: vi.fn(), execute: vi.fn(), getConnection: vi.fn(), end: vi.fn() })
  })

  it('reads big numbers as exact text by default', async () => {
    const options = await poolOptions({ host: 'db' })

    expect(options).toMatchObject({ supportBigNumbers: true, bigNumberStrings: false })
  })

  it('lets URL parameters replace both big number defaults', async () => {
    const options = await poolOptions({ uri: 'mysql://root@db/app?supportBigNumbers=false' })

    expect(options).toMatchObject({ supportBigNumbers: false, bigNumberStrings: false })
    expect(new URL(options.uri!).searchParams.has('supportBigNumbers')).toBe(false)
  })

  it('lets explicit false settings win over URL parameters', async () => {
    const options = await poolOptions({
      uri: 'mysql://root@db/app?supportBigNumbers=true&bigNumberStrings=true',
      supportBigNumbers: false,
      bigNumberStrings: false,
    })

    expect(options).toMatchObject({ supportBigNumbers: false, bigNumberStrings: false })
    expect(new URL(options.uri!).searchParams.has('supportBigNumbers')).toBe(false)
    expect(new URL(options.uri!).searchParams.has('bigNumberStrings')).toBe(false)
  })

  it('parses MySQL and MariaDB JSON with JSON.parse', async () => {
    const options = await poolOptions({ host: 'db' })

    expect(readField(options, field({ type: 'JSON', text: '{"big":9007199254740993}' }))).toEqual(JSON.parse('{"big":9007199254740993}'))
    expect(readField(options, field({ extendedFormat: 'json', text: '[9007199254740993]', encoding: 'utf8mb4' }))).toEqual(JSON.parse('[9007199254740993]'))
    expect(readField(options, field({ extendedFormat: 'json', text: null }))).toBeNull()
    expect(readField(options, field({ type: 'LONG_BLOB', text: '{"a":1}' }))).toBe('driver')
  })

  it('leaves JSON to the driver when jsonStrings is set', async () => {
    const options = await poolOptions({ uri: 'mysql://root@db/app?jsonStrings=true' })

    expect(readField(options, field({ extendedFormat: 'json', text: '[1]' }))).toBe('driver')
  })
})
