import { describe, expect, it } from 'vitest'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel } from '../src'
import { openDatabase } from './support/database'

describe('belongsToMany related casts', () => {
  it('applies the related model casts once to eager-loaded rows', async () => {
    const { db, schema } = await openDatabase('sqlite')
    await schema.createTable('cast_groups', (table) => {
      table.id()
    })
    await schema.createTable('cast_labels', (table) => {
      table.id()
      table.string('secret')
      table.text('meta')
    })
    await schema.createTable('cast_group_labels', (table) => {
      table.id()
      table.bigInteger('group_id')
      table.bigInteger('label_id')
    })
    const groups = defineGeneratedTable('cast_groups', { id: column.id() })
    const labels = defineGeneratedTable('cast_labels', { id: column.id(), secret: column.string(), meta: column.text() })
    const groupLabels = defineGeneratedTable('cast_group_labels', { id: column.id(), group_id: column.bigInteger(), label_id: column.bigInteger() })
    await db.table(groups).insert({ id: 1 })
    await db.table(labels).insert({ id: 1, secret: 's1', meta: '{"a":1}' })
    await db.table(groupLabels).insert({ id: 1, group_id: 1, label_id: 1 })
    const Label = defineModel(labels, { timestamps: false, casts: { secret: { get: value => `secret:${String(value)}`, set: value => value }, meta: 'json' } })
    const Group = defineModel(groups, { timestamps: false, relations: { labels: belongsToMany(() => Label, groupLabels, 'group_id', 'label_id') } })

    const [group] = await db.model(Group).query().with('labels').getJson() as unknown as { labels: Record<string, unknown>[] }[]
    const direct = await db.model(Label).query().getJson()

    expect(group?.labels[0]).toMatchObject(direct[0]!)
    expect(group?.labels[0]?.secret).toBe('secret:s1')
  })

  it('keeps the related model default eager loads on belongsToMany rows', async () => {
    const { db, schema } = await openDatabase('sqlite')
    await schema.createTable('eager_kinds', (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable('eager_groups', (table) => {
      table.id()
    })
    await schema.createTable('eager_labels', (table) => {
      table.id()
      table.bigInteger('kind_id')
    })
    await schema.createTable('eager_group_labels', (table) => {
      table.id()
      table.bigInteger('group_id')
      table.bigInteger('label_id')
    })
    const kinds = defineGeneratedTable('eager_kinds', { id: column.id(), name: column.string() })
    const groups = defineGeneratedTable('eager_groups', { id: column.id() })
    const labels = defineGeneratedTable('eager_labels', { id: column.id(), kind_id: column.bigInteger() })
    const groupLabels = defineGeneratedTable('eager_group_labels', { id: column.id(), group_id: column.bigInteger(), label_id: column.bigInteger() })
    await db.table(kinds).insert({ id: 1, name: 'colour' })
    await db.table(groups).insert({ id: 1 })
    await db.table(labels).insert({ id: 1, kind_id: 1 })
    await db.table(groupLabels).insert({ id: 1, group_id: 1, label_id: 1 })
    const Kind = defineModel(kinds, { timestamps: false })
    const Label = defineModel(labels, { timestamps: false, with: ['kind'], relations: { kind: belongsTo(() => Kind, 'kind_id') } })
    const Group = defineModel(groups, { timestamps: false, relations: { labels: belongsToMany(() => Label, groupLabels, 'group_id', 'label_id') } })

    const [group] = await db.model(Group).query().with('labels').getJson() as unknown as { labels: Record<string, unknown>[] }[]

    expect(group?.labels[0]?.kind).toEqual({ id: 1, name: 'colour' })
  })
})
