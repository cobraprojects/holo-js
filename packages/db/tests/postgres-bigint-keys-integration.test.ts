import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, HydrationError, belongsToMany, column, defineGeneratedTable, defineModel, morphToMany, morphedByMany, resetDB } from '../src'
import { openDatabase } from './support/database'

async function openBigintScenario() {
  const { schema, adapter } = await openDatabase('postgres')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    groups: `int8_groups_${suffix}`,
    members: `int8_members_${suffix}`,
    memberships: `int8_group_members_${suffix}`,
    tags: `int8_tags_${suffix}`,
    taggables: `int8_taggables_${suffix}`,
  }
  await schema.createTable(names.groups, table => { table.id(); table.string('name') })
  await schema.createTable(names.members, table => { table.id(); table.string('name') })
  await schema.createTable(names.tags, table => { table.id(); table.string('name') })
  await adapter.execute(`CREATE TABLE ${names.memberships} (id bigserial PRIMARY KEY, group_id bigint NOT NULL, member_id bigint NOT NULL)`)
  await adapter.execute(`CREATE TABLE ${names.taggables} (tag_id bigint NOT NULL, taggable_id bigint NOT NULL, taggable_type varchar(255) NOT NULL)`)
  return { schema, names }
}

describe('postgres bigint keys', () => {
  afterEach(() => resetDB())

  it('loads, counts and filters pivot relations keyed by id() and foreignId() columns', async () => {
    const { schema, names } = await openBigintScenario()
    try {
      const groups = defineGeneratedTable(names.groups, { id: column.id(), name: column.string() })
      const members = defineGeneratedTable(names.members, { id: column.id(), name: column.string() })
      const tags = defineGeneratedTable(names.tags, { id: column.id(), name: column.string() })
      const Member = defineModel(members, { timestamps: false, fillable: ['name'] })
      const Tag = defineModel(tags, { timestamps: false, fillable: ['name'] })
      const Group = defineModel(groups, {
        timestamps: false,
        fillable: ['name'],
        morphClass: 'groups',
        relations: {
          members: belongsToMany(() => Member, names.memberships, 'group_id', 'member_id'),
          tags: morphToMany(() => Tag, 'taggable', names.taggables, 'tag_id'),
        },
      })
      const TagWithGroups = defineModel(tags, {
        timestamps: false,
        relations: { groups: morphedByMany(() => Group, 'taggable', names.taggables, 'tag_id') },
      })
      const [group, empty] = [await Group.create({ name: 'g' }), await Group.create({ name: 'empty' })]
      const member = await Member.create({ name: 'm' })
      const tag = await Tag.create({ name: 't' })
      await DB.table(names.memberships).insert({ group_id: group.id, member_id: member.id })
      await DB.table(names.taggables).insert({ tag_id: tag.id, taggable_id: group.id, taggable_type: 'groups' })

      const loaded = await Group.with('members', 'tags').withCount('members').orderBy('id').get()
      const [withMembers] = await Group.has('members').get()
      const [taggedBy] = await TagWithGroups.with('groups').get()

      expect(loaded.map(entity => entity.members.map(related => related.id))).toEqual([[member.id], []])
      expect(loaded.map(entity => entity.get('members_count' as never))).toEqual([1, 0])
      expect(loaded.map(entity => entity.tags.map(related => related.id))).toEqual([[tag.id], []])
      expect(withMembers?.id).toBe(group.id)
      expect(empty.id).not.toBe(group.id)
      expect(taggedBy?.groups.map(related => related.id)).toEqual([group.id])
    } finally {
      for (const name of Object.values(names).reverse()) await schema.dropTable(name)
    }
  })

  it('reads id() and foreignId() columns of declared tables as numbers, like models', async () => {
    const { schema, names } = await openBigintScenario()
    try {
      const groups = defineGeneratedTable(names.groups, { id: column.id(), name: column.string() })
      const memberships = defineGeneratedTable(names.memberships, { id: column.id(), group_id: column.foreignId(), member_id: column.foreignId() })
      const Group = defineModel(groups, { timestamps: false, fillable: ['name'] })
      const group = await Group.create({ name: 'g' })
      await DB.table(memberships).insert({ group_id: group.id, member_id: 7 })

      const row = await DB.table(memberships).first()
      const joined = await DB.table(memberships)
        .join(groups, `${names.memberships}.group_id`, '=', `${names.groups}.id`)
        .select(`${names.groups}.id as groupKey`, `${names.memberships}.member_id`, `${names.groups}.name`)
        .first()

      expect(row).toEqual({ id: 1, group_id: group.id, member_id: 7 })
      expect(await DB.table(memberships).pluck('member_id')).toEqual([7])
      expect(await DB.table(memberships).value('group_id')).toBe(group.id)
      expect(joined).toEqual({ groupKey: group.id, member_id: 7, name: 'g' })
      schema.register(memberships)
      expect(await DB.table(names.memberships).first()).toEqual({ id: '1', group_id: String(group.id), member_id: '7' })
      expect(await DB.table(names.memberships)
        .join(names.groups, `${names.memberships}.group_id`, '=', `${names.groups}.id`)
        .select(`${names.groups}.id as groupKey`)
        .first()).toEqual({ groupKey: String(group.id) })

      await DB.table(memberships).insert({ group_id: group.id, member_id: '9007199254740993' })
      await expect(DB.table(memberships).where('id', 2).first()).rejects.toThrow(HydrationError)
    } finally {
      for (const name of Object.values(names).reverse()) await schema.dropTable(name)
    }
  })
})
