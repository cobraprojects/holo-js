import { expectTypeOf, it } from 'vitest'
import { DB, column, defineGeneratedTable, type CursorPaginatedResult, type DateBucket, type DateColumnName, type InferSelect, type TableDefinition } from '../src'

const campaigns = defineGeneratedTable('bucket_campaigns', { id: column.id(), visibility: column.string() })
const events = defineGeneratedTable('bucket_events', {
  id: column.id(),
  campaign_id: column.integer(),
  channel: column.string(),
  occurred_at: column.datetime(),
  billed_on: column.date().nullable(),
  payload: column.json<null>().nullable(),
})

function channelBreakdown<TTable extends TableDefinition, TKey extends keyof InferSelect<TTable> & string>(table: TTable, key: TKey) {
  return DB.table(table)
    .join(campaigns, 'bucket_campaigns.id', '=', 'bucket_campaigns.id')
    .select(`${key} as key`, 'bucket_campaigns.visibility')
    .addSelectCount('total')
    .groupBy(key, 'bucket_campaigns.visibility')
    .get()
}

async function dailyTotals<TTable extends TableDefinition, TColumn extends DateColumnName<InferSelect<TTable>>>(table: TTable, at: TColumn) {
  const rows = await DB.table(table).selectDate('day', at, { as: 'day', timeZone: 'UTC' }).addSelectCount('total').groupBy('day').get()
  return rows.map(row => ({ day: row.day, total: row.total }))
}

it('types date buckets as nullable unit-branded strings', async () => {
  if (false) {
    const rows = await DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectDate('month', 'billed_on', { as: 'month' })
      .addSelectCount('total')
      .groupBy('day', 'month')
      .orderByDesc('day')
      .orderBy('month')
      .get()
    expectTypeOf(rows[0]!.day).toEqualTypeOf<DateBucket<'day'> | null>()
    expectTypeOf(rows[0]!.month).toEqualTypeOf<DateBucket<'month'> | null>()
    expectTypeOf(rows[0]!.total).toEqualTypeOf<number>()
    expectTypeOf<keyof typeof rows[0]>().toEqualTypeOf<'day' | 'month' | 'total'>()
    const label: string = rows[0]!.day ?? ''
    void label

    const page = await DB.table(events).selectDate('hour', 'occurred_at', { as: 'hour' }).addSelectCount('total').groupBy('hour').orderByDesc('hour').cursorPaginate(30)
    expectTypeOf(page).toEqualTypeOf<CursorPaginatedResult<{ hour: DateBucket<'hour'> | null } & { total: number }>>()
  }
})

it('keeps the table columns when a date bucket is the first added selection', async () => {
  if (false) {
    const rows = await DB.table(events).addSelectDate('day', 'occurred_at', { as: 'day' }).get()
    expectTypeOf(rows[0]!.channel).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.day).toEqualTypeOf<DateBucket<'day'> | null>()
  }
})

it('drops a replaced selection type when a projection of unknown name is added', async () => {
  if (false) {
    const projection: string = 'label as total'
    const rows = await DB.table('bucket_events').selectCount('total').addSelect(projection).get()
    expectTypeOf(rows[0]!.total).toEqualTypeOf<unknown>()
  }
})

it('keeps the date bucket type next to a wildcard of a table joined by name', async () => {
  if (false) {
    const row = await DB.table(events)
      .join('bucket_labels', 'bucket_labels.id', '=', 'bucket_events.id')
      .selectDate('day', 'occurred_at', { as: 'bucket' })
      .addSelect('bucket_labels.*')
      .first()
    expectTypeOf(row!.bucket).toEqualTypeOf<DateBucket<'day'> | null>()
  }
})

it('accepts date bucket aliases wherever an order is set', () => {
  if (false) {
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).orderBy('day').reorder('day', 'desc')
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).latest('day')
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).oldest('day')
    // @ts-expect-error reorder only accepts declared columns and selected date buckets
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).reorder('week')
  }
})

it('rejects date buckets on non-date columns, unknown units and aliases that shadow a column', () => {
  if (false) {
    // @ts-expect-error only date, datetime and timestamp columns can be bucketed
    DB.table(events).selectDate('day', 'channel', { as: 'day' })
    // @ts-expect-error a JSON column that only holds null is not a date column
    DB.table(events).selectDate('day', 'payload', { as: 'day' })
    const either = 'first_day' as 'first_day' | 'last_day'
    // @ts-expect-error the alias must be one string literal so the row type knows its key
    DB.table(events).selectDate('day', 'occurred_at', { as: either })
    const runtime: string = 'day'
    // @ts-expect-error the alias must be one string literal so the row type knows its key
    DB.table(events).selectDate('day', 'occurred_at', { as: runtime })
    // @ts-expect-error a selected null-only JSON column is not a date bucket alias
    DB.table(events).select('payload as missing').groupBy('missing')
    // @ts-expect-error unknown units are rejected
    DB.table(events).selectDate('week', 'occurred_at', { as: 'week' })
    // @ts-expect-error the alias must not reuse a column name
    DB.table(events).selectDate('day', 'occurred_at', { as: 'channel' })
    // @ts-expect-error groupBy only accepts declared columns and selected date buckets
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).groupBy('week')
    // @ts-expect-error orderBy only accepts declared columns and selected date buckets
    DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).orderByDesc('week')
  }
})

it('resolves aliased selections of generic query helpers at the call site', async () => {
  if (false) {
    const rows = await channelBreakdown(events, 'channel')
    expectTypeOf<keyof typeof rows[0]>().toEqualTypeOf<'key' | 'visibility' | 'total'>()
    expectTypeOf(rows[0]!.key).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.visibility).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.total).toEqualTypeOf<number>()

    const days = await dailyTotals(events, 'occurred_at')
    expectTypeOf(days[0]!).toEqualTypeOf<{ day: DateBucket<'day'> | null, total: number }>()
    // @ts-expect-error a generic helper constrained with DateColumnName rejects non-date columns
    await dailyTotals(events, 'channel')
  }
})
