import { describe, expect, expectTypeOf, it } from 'vitest'
import { CompilerError, DB, HydrationError, InvalidCursorException, SecurityError } from '../src'
import { defineModelFromTable } from './support/internal'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

const clientCursors = {
  'not base64 JSON': 'abc',
  'JSON without values': encodeCursor({ offset: 2 }),
  'a non-array values field': encodeCursor({ values: 'Ava' }),
  'an object value': encodeCursor({ values: [{}] }),
  'a non-boolean previous flag': encodeCursor({ values: [1], previous: 'yes' }),
  'more values than the ordering': encodeCursor({ values: [1, 2] }),
  'fewer values than the ordering': encodeCursor({ values: [] }),
  'non-canonical base64url': `!${encodeCursor({ values: [1] })}?`,
  'bytes that are not UTF-8 inside a JSON string': Buffer.concat([Buffer.from('{"values":["a'), Buffer.from([0xFF]), Buffer.from('"]}')]).toString('base64url'),
  'base64url with nonzero unused bits': 'eyJ2YWx1ZXMiOlsxXX1',
  'a JSON number that overflows to infinity': Buffer.from('{"values":[1e400]}').toString('base64url'),
  'a byte order mark before the JSON': Buffer.from('\uFEFF{"values":[1]}').toString('base64url'),
} as const

async function openUsers(driver: typeof drivers[number]) {
  const { table } = await openDatabase(driver)
  await DB.table(table).insert([
    { id: 1, name: 'Ava', active: true },
    { id: 2, name: 'Ben', active: false },
    { id: 3, name: 'Cy', active: true },
  ])
  return { table, User: defineModelFromTable(table) }
}

describe.each(drivers)('invalid cursors on %s', (driver) => {
  it.each(Object.entries(clientCursors))('rejects %s as an invalid cursor on table and model queries', async (_label, cursor) => {
    const { table, User } = await openUsers(driver)
    const pages = [
      DB.table(table).orderBy('id').cursorPaginate(2, cursor),
      User.query().orderBy('id').cursorPaginate(2, cursor),
      User.query().orderBy('id').cursorPaginateJson(2, cursor),
    ]

    for (const page of pages) {
      const error = await page.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(InvalidCursorException)
      expect(error).toHaveProperty('cause', undefined)
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'INVALID_CURSOR',
        cursorName: 'cursor',
        message: 'The cursor is invalid.',
        errors: { cursor: ['The cursor is invalid.'] },
      })
    }
  })

  it('exposes the invalid cursor code as a literal type', () => {
    expectTypeOf(new InvalidCursorException('cursor').code).toEqualTypeOf<'INVALID_CURSOR'>()
  })

  it('reports the configured cursor name and message', async () => {
    const { table, User } = await openUsers(driver)
    const options = { cursorName: 'after', invalidCursorMessage: 'Reload the first page.' }
    const expected = { cursorName: 'after', message: 'Reload the first page.', errors: { after: ['Reload the first page.'] } }

    await expect(DB.table(table).orderBy('id').cursorPaginate(2, 'abc', options)).rejects.toMatchObject(expected)
    await expect(User.query().orderBy('id').cursorPaginate(2, encodeCursor({ values: [1, 2] }), options)).rejects.toMatchObject(expected)
  })

  it('keeps paging with cursors the paginator issued', async () => {
    const { table, User } = await openUsers(driver)
    const first = await DB.table(table).orderBy('active').orderBy('name', 'desc').cursorPaginate(2)
    const second = await DB.table(table).orderBy('active').orderBy('name', 'desc').cursorPaginate(2, first.nextCursor)
    expect(second.data.map(row => row.id)).toEqual([1])

    const firstModels = await User.query().orderBy('id', 'desc').cursorPaginate(2)
    const secondModels = await User.query().orderBy('id', 'desc').cursorPaginate(2, firstModels.nextCursor)
    expect(secondModels.data.map(user => user.id)).toEqual([1])

    const reused = DB.table(table).orderBy('id').limit(-1).offset(-1)
    const firstReused = await reused.cursorPaginate(2)
    expect((await reused.cursorPaginate(2, firstReused.nextCursor)).data.map(row => row.id)).toEqual([3])

    const issued = `${firstModels.nextCursor}`
    await expect(User.query().orderBy('id', 'desc').cursorPaginate(2, `${issued}!`)).rejects.toThrow(InvalidCursorException)
  })

  it('keeps reporting query mistakes as developer errors', async () => {
    const { table, User } = await openUsers(driver)

    await expect(DB.table(table).inRandomOrder().cursorPaginate(2, 'abc')).rejects.toThrow(SecurityError)
    await expect(User.query().inRandomOrder().cursorPaginate(2, 'abc')).rejects.toThrow(SecurityError)
    await expect(DB.table(table).orderBy(`${table.tableName}..id` as 'id').cursorPaginate(2, 'abc')).rejects.toThrow(SecurityError)
    if (driver === 'sqlite') {
      await expect(DB.table(table).joinLateral(DB.table(table).select('id').limit(1), 'latest').orderBy('id').cursorPaginate(2, 'abc')).rejects.toThrow(CompilerError)
    }
    await expect(DB.table(table).orderBy('id').cursorPaginate(2, 'abc', { cursorName: 1 as unknown as string })).rejects.toThrow(SecurityError)
    await expect(DB.table(table).orderBy('id').cursorPaginate(2, null, { invalidCursorMessage: ' ' })).rejects.toThrow(SecurityError)
    await expect(User.cursorPaginate(2, null, { invalidCursorMessage: '' })).rejects.toThrow(HydrationError)
    for (const cursorName of ['__proto__', 'constructor', 'prototype', 'pagination.constructor']) {
      await expect(DB.table(table).orderBy('id').cursorPaginate(2, null, { cursorName })).rejects.toThrow(SecurityError)
      await expect(User.cursorPaginate(2, null, { cursorName })).rejects.toThrow(HydrationError)
    }
  })
})
