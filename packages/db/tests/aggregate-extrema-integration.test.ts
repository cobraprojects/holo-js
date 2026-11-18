import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { column, DB, defineGeneratedTable, defineModel, hasMany, latestOfMany, oldestOfMany, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

async function openRedemptionsFixture(driver: 'sqlite' | 'postgres' | 'mysql') {
  const { schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const actorsName = `extrema_actors_${suffix}`
  const redemptionsName = `extrema_redemptions_${suffix}`
  await schema.createTable(actorsName, table => { table.integer('id').primaryKey() })
  onTestFinished(() => schema.dropTable(actorsName))
  await schema.createTable(redemptionsName, table => {
    table.integer('id').primaryKey()
    table.integer('tenant_id')
    table.integer('actor_user_id')
    table.string('code')
    table.integer('points')
    table.bigInteger('balance')
    table.decimal('amount', 8, 2)
    table.timestamp('redeemed_at')
  })
  onTestFinished(() => schema.dropTable(redemptionsName))
  const redemptions = defineGeneratedTable(redemptionsName, {
    id: column.integer().primaryKey(),
    tenant_id: column.integer(),
    actor_user_id: column.integer(),
    code: column.string(),
    points: column.integer(),
    balance: column.bigInteger(),
    amount: column.decimal(undefined, 8, 2),
    redeemed_at: column.timestamp(),
  })
  const actors = defineGeneratedTable(actorsName, { id: column.integer().primaryKey() })
  const early = new Date('2026-01-01T10:00:00Z')
  const late = new Date('2026-02-01T10:00:00Z')
  await DB.table(actors).insert([{ id: 1 }])
  await DB.table(redemptions).insert([
    { id: 1, tenant_id: 1, actor_user_id: 1, code: 'Zulu', points: 10, balance: 10, amount: '12.50', redeemed_at: late },
    { id: 2, tenant_id: 1, actor_user_id: 1, code: 'Alpha', points: 2, balance: 2, amount: '3.25', redeemed_at: early },
  ])
  return { actors, redemptions, early, late }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('selected extrema on %s', driver => {
  it('returns extrema exactly as the driver returns the selected column', async () => {
    const { redemptions } = await openRedemptionsFixture(driver)
    const [lowest, highest] = await DB.table(redemptions).select('redeemed_at', 'code', 'points', 'amount').orderBy('id', 'desc').get()

    const rows = await DB.table(redemptions).where('tenant_id', 1).groupBy('actor_user_id')
      .select('actor_user_id').addSelectCount('redemptions')
      .addSelectMin('first_redeemed_at', 'redeemed_at').addSelectMax('last_redeemed_at', 'redeemed_at')
      .addSelectMin('first_code', 'code').addSelectMax('last_code', 'code')
      .addSelectMin('lowest_points', 'points').addSelectMax('highest_points', 'points')
      .addSelectMin('lowest_amount', 'amount').addSelectMax('highest_amount', 'amount')
      .get()

    expect(rows).toEqual([{
      actor_user_id: 1,
      redemptions: 2,
      first_redeemed_at: lowest!.redeemed_at,
      last_redeemed_at: highest!.redeemed_at,
      first_code: 'Alpha',
      last_code: 'Zulu',
      lowest_points: 2,
      highest_points: 10,
      lowest_amount: '3.25',
      highest_amount: '12.50',
    }])
    if (driver !== 'sqlite') expect(rows[0]!.last_redeemed_at).toBeInstanceOf(Date)
  })

  it('keeps numeric extrema numeric when a union widens their SQL type', async () => {
    const { redemptions } = await openRedemptionsFixture(driver)

    const rows = await DB.table(redemptions).selectMax('value', 'points')
      .unionAll(DB.table(redemptions).selectCount('value'))
      .get()

    expect(rows).toEqual([{ value: 10 }, { value: 2 }])
  })

  it('keeps big integer extrema numeric alongside raw selections', async () => {
    const { redemptions } = await openRedemptionsFixture(driver)

    const row = await DB.table(redemptions).selectMax('highest_balance', 'balance').addUnsafeSelect('? as marker', ['raw']).first()

    expect(row).toEqual({ highest_balance: 10, marker: 'raw' })
  })

  it('returns null extrema for empty groups', async () => {
    const { redemptions } = await openRedemptionsFixture(driver)

    const row = await DB.table(redemptions).where('tenant_id', 2)
      .selectMax('last_redeemed_at', 'redeemed_at').addSelectMin('first_code', 'code').first()

    expect(row).toEqual({ last_redeemed_at: null, first_code: null })
  })

  it('loads timestamp relation extrema through one-of-many relations', async () => {
    const { actors, redemptions, early, late } = await openRedemptionsFixture(driver)
    const Redemption = defineModel(redemptions, { timestamps: false })
    const Actor = defineModel(actors, {
      timestamps: false,
      relations: {
        redemptions: hasMany(() => Redemption, 'actor_user_id'),
        latestRedemption: latestOfMany(() => Redemption, 'actor_user_id', 'id', 'redeemed_at'),
        firstRedemption: oldestOfMany(() => Redemption, 'actor_user_id', 'id', 'redeemed_at'),
      },
    })

    const actor = await Actor.query()
      .withMax('redemptions', 'redeemed_at')
      .withMax('latestRedemption', 'redeemed_at')
      .withMin('firstRedemption', 'redeemed_at')
      .with('latestRedemption')
      .findOrFail(1)

    expect(actor.toAttributes()).toMatchObject({
      redemptions_max_redeemed_at: late,
      latestRedemption_max_redeemed_at: late,
      firstRedemption_min_redeemed_at: early,
    })
    expect(actor.latestRedemption?.code).toBe('Zulu')
  })
})
