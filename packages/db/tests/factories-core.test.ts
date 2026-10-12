import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  type Entity,
  belongsTo,
  belongsToMany,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  defineFactory,
  defineModel,
  hasMany,
  hasOne,
  morphMany,
  morphOne,
  morphTo,
  morphToMany,
  morphedByMany,
  resetDB,
  HydrationError,
  SecurityError,
  type TableDefinition } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

type TestEntity = Entity<TableDefinition>

function createTestAdapter(): ReturnType<typeof createSQLiteAdapter> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  return adapter
}

describe('factory slice', () => {
  beforeEach(() => {
    resetDB()
  })

  it('supports make/create, states, sequences, counts, and raw attributes', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, {
      fillable: ['name', 'status'] })

    const factory = defineFactory(User, ({ sequence }) => ({
      name: `User ${sequence}`,
      status: 'draft' }))
      .sequence()
      .state({ status: 'active' })
      .sequence(
        { name: 'Amina' },
        (_attributes, context) => ({ name: `Layla ${context.sequence}` }),
      )

    await expect(factory.raw({ status: 'queued' })).resolves.toEqual({
      name: 'Amina',
      status: 'queued' })

    const madeOne = await factory.make()
    if (Array.isArray(madeOne)) {
      throw new TypeError('Expected a single entity from make().')
    }
    expect(madeOne.exists()).toBe(false)
    expect(madeOne.get('name')).toBe('Amina')

    const createdOne = await factory.create()
    if (Array.isArray(createdOne)) {
      throw new TypeError('Expected a single entity from create().')
    }
    expect(createdOne.exists()).toBe(true)
    expect(createdOne.get('id')).toBe(1)

    await expect(factory.count(3).raw()).resolves.toEqual([
      { name: 'Amina', status: 'active' },
      { name: 'Layla 2', status: 'active' },
      { name: 'Amina', status: 'active' },
    ])

    const madeViaMake = await factory.count(2).make()
    expect(Array.isArray(madeViaMake)).toBe(true)
    if (!Array.isArray(madeViaMake)) {
      throw new TypeError('Expected make() to return multiple entities when count() is used.')
    }
    expect(madeViaMake).toHaveLength(2)

    const made = await factory.makeMany(2)
    expect(made).toHaveLength(2)
    expect(made[0]!.exists()).toBe(false)
    expect(made[0]!.get('name')).toBe('Amina')
    expect(made[1]!.get('name')).toBe('Layla 2')

    const created = await factory.createMany(2)
    expect(created).toHaveLength(2)
    expect(created[0]!.exists()).toBe(true)
    expect(created[0]!.get('id')).toBe(2)
    expect(created[1]!.get('id')).toBe(3)
    expect(await db.table('users').orderBy('id').get()).toEqual([
      { id: 1, name: 'Amina', status: 'active' },
      { id: 2, name: 'Amina', status: 'active' },
      { id: 3, name: 'Layla 2', status: 'active' },
    ])
  })

  it('supports afterMaking and afterCreating hooks in order', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    const calls: string[] = []
    const factory = defineFactory(User, ({ sequence }) => ({
      name: `User ${sequence}` }))
      .afterMaking((entity, context) => {
        calls.push(`made:${context.sequence}:${entity.get('name')}`)
      })
      .afterCreating((entity, context) => {
        calls.push(`created:${context.sequence}:${entity.get('name')}:${entity.get('id')}`)
      })

    await factory.makeOne()
    await factory.createOne()
    await factory.count(2).create()

    expect(calls).toEqual([
      'made:1:User 1',
      'created:1:User 1:1',
      'created:1:User 1:2',
      'created:2:User 2:3',
    ])
  })

  it('propagates callback failures', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(
      defineFactory(User, () => ({ name: 'Broken make' }))
        .afterMaking(() => {
          throw new Error('after making failed')
        })
        .makeOne(),
    ).rejects.toThrow('after making failed')

    await expect(
      defineFactory(User, () => ({ name: 'Broken create' }))
        .afterCreating(() => {
          throw new Error('after creating failed')
        })
        .createOne(),
    ).rejects.toThrow('after creating failed')

    expect(await db.table('users').orderBy('id').get()).toEqual([
      { id: 1, name: 'Broken create' },
    ])
  })

  it('supports belongsTo, hasMany, and belongsToMany relation-aware factories', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, teams)
    const users = defineTable('users', {
      id: column.id(),
      teamId: column.integer().nullable(),
      name: column.string() })
    await createTestTable(db, users)
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    await createTestTable(db, posts)
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, roles)
    const roleUser = defineTable('roleUser', {
      userId: column.integer(),
      roleId: column.integer(),
      active: column.boolean().default(true) })
    await createTestTable(db, roleUser)

    const Team = defineModelFromTable(teams, {
      fillable: ['name'] })
    const Post = defineModelFromTable(posts, {
      fillable: ['title', 'userId'] })
    const Role = defineModelFromTable(roles, {
      fillable: ['name'] })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'teamId'],
      relations: {
        team: belongsTo(() => Team, 'teamId'),
        posts: hasMany(() => Post, 'userId'),
        roles: belongsToMany(() => Role, roleUser, 'userId', 'roleId').withPivot('active') } })

    const teamFactory = defineFactory(Team, () => ({ name: 'Core' }))
    const postFactory = defineFactory(Post, ({ sequence }) => ({ title: `Post ${sequence}` })).count(2)
    const roleFactory = defineFactory(Role, ({ sequence }) => ({ name: `Role ${sequence}` })).count(2)
    const userFactory = defineFactory(User, () => ({ name: 'Amina' }))
      .for(teamFactory, 'team')
      .has(postFactory, 'posts')
      .hasAttached(roleFactory, 'roles', { active: true })

    const draft = await userFactory.makeOne()
    expect(draft.exists()).toBe(false)
    expect(draft.getRelation<Entity<TableDefinition>>('team').exists()).toBe(false)
    expect(draft.get('teamId')).toBeUndefined()
    expect(draft.getRelation<Entity<TableDefinition>[]>('posts')).toHaveLength(2)
    expect(draft.getRelation<Entity<TableDefinition>[]>('roles')).toHaveLength(2)
    expect(draft.getRelation<Entity<TableDefinition>[]>('roles')[0]!.getRelation('pivot')).toMatchObject({ active: true })

    const created = await userFactory.createOne()
    expect(created.exists()).toBe(true)
    expect(created.get('teamId')).toBe(1)
    expect(created.getRelation<Entity<TableDefinition>>('team').exists()).toBe(true)
    expect(created.getRelation<Entity<TableDefinition>[]>('posts')).toHaveLength(2)
    expect(created.getRelation<Entity<TableDefinition>[]>('posts')[0]!.get('userId')).toBe(1)
    expect(created.getRelation<Entity<TableDefinition>[]>('roles')).toHaveLength(2)
    expect(created.getRelation<Entity<TableDefinition>[]>('roles')[0]!.getRelation('pivot')).toMatchObject({
      userId: 1,
      roleId: 1,
      active: true })

    expect(await db.table('teams').orderBy('id').get()).toEqual([
      { id: 1, name: 'Core' },
    ])
    expect(await db.table('users').orderBy('id').get()).toEqual([
      { id: 1, name: 'Amina', teamId: 1 },
    ])
    expect(await db.table('posts').orderBy('id').get()).toEqual([
      { id: 1, title: 'Post 1', userId: 1 },
      { id: 2, title: 'Post 2', userId: 1 },
    ])
    expect(await db.table('roles').orderBy('id').get()).toEqual([
      { id: 1, name: 'Role 1' },
      { id: 2, name: 'Role 2' },
    ])
    expect(await db.table('roleUser').orderBy('userId').orderBy('roleId').get()).toEqual([
      { userId: 1, roleId: 1, active: 1 },
      { userId: 1, roleId: 2, active: 1 },
    ])

    const directTeam = await Team.create({ name: 'Direct Team' })
    const directRoles = await roleFactory.createMany(2, { name: 'Direct Role' })
    const directUser = await defineFactory(User, () => ({ name: 'Direct User' }))
      .for(directTeam, 'team')
      .hasAttached(directRoles, 'roles', { active: false })
      .createOne()

    expect(directUser.get('teamId')).toBe(2)
    expect(directUser.getRelation<Entity<TableDefinition>>('team').get('name')).toBe('Direct Team')
    expect(directUser.getRelation<Entity<TableDefinition>[]>('roles')).toHaveLength(2)

    const singleRole = await Role.create({ name: 'Single Role' })
    const singleAttachedUser = await defineFactory(User, () => ({ name: 'Single Attached User' }))
      .for(directTeam, 'team')
      .hasAttached(singleRole, 'roles', { active: true })
      .createOne()
    expect(singleAttachedUser.getRelation<Entity<TableDefinition>[]>('roles')).toHaveLength(1)

    const recycledTeam = await Team.create({ name: 'Recycled Team' })
    const recycledRoles = await roleFactory.createMany(2, { name: 'Recycled Role' })
    const recycledUser = await defineFactory(User, () => ({ name: 'Recycled User' }))
      .recycle(recycledTeam)
      .recycle(recycledRoles)
      .for(teamFactory, 'team')
      .hasAttached(roleFactory, 'roles', { active: true })
      .createOne()

    expect(recycledUser.get('teamId')).toBe(recycledTeam.get('id'))
    expect(recycledUser.getRelation<Entity<TableDefinition>>('team').get('name')).toBe('Recycled Team')
    expect(recycledUser.getRelation<Entity<TableDefinition>[]>('roles').map(role => role.get('id'))).toEqual(
      recycledRoles.map(role => role.get('id')),
    )
    expect(await db.table('teams').orderBy('id').get()).toHaveLength(3)
    expect(await db.table('roles').orderBy('id').get()).toHaveLength(7)
  })

  it('supports morphTo, morphMany, morphToMany, and morphedByMany relation-aware factories', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })
    await createTestTable(db, posts)
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string().nullable(),
      imageableId: column.integer().nullable(),
      url: column.string() })
    await createTestTable(db, images)
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, tags)
    const taggables = defineTable('taggables', {
      id: column.id(),
      tagId: column.integer(),
      taggableType: column.string(),
      taggableId: column.integer(),
      active: column.boolean().default(true) })
    await createTestTable(db, taggables)
    const comments = defineTable('comments', {
      id: column.id(),
      commentableType: column.string().nullable(),
      commentableId: column.integer().nullable(),
      body: column.string() })
    await createTestTable(db, comments)

    const Image = defineModelFromTable(images, {
      fillable: ['imageableType', 'imageableId', 'url'],
      relations: {
        imageable: morphTo('imageable', 'imageableType', 'imageableId') } })
    const Comment = defineModelFromTable(comments, {
      fillable: ['commentableType', 'commentableId', 'body'],
      relations: {
        commentable: morphTo('commentable', 'commentableType', 'commentableId') } })
    let Post!: ReturnType<typeof defineModelFromTable<typeof posts>>
    const Tag = defineModelFromTable(tags, {
      fillable: ['name'],
      relations: {
        posts: morphedByMany(() => Post, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId').withPivot('active') } })
    Post = defineModelFromTable(posts, {
      fillable: ['title'],
      relations: {
        images: morphMany(() => Image, 'imageable', 'imageableType', 'imageableId'),
        tags: morphToMany(() => Tag, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId').withPivot('active') } })

    const postFactory = defineFactory(Post, () => ({ title: 'Post' }))
    const imageFactory = defineFactory(Image, ({ sequence }) => ({ url: `/img-${sequence}.png` })).count(2)
    const tagFactory = defineFactory(Tag, ({ sequence }) => ({ name: `Tag ${sequence}` })).count(2)
    const commentFactory = defineFactory(Comment, () => ({ body: 'Nice' })).for(postFactory, 'commentable')

    const draftComment = await commentFactory.makeOne()
    expect(draftComment.get('commentableType')).toBeUndefined()
    expect(draftComment.getRelation<Entity<TableDefinition>>('commentable').exists()).toBe(false)

    const createdComment = await commentFactory.createOne()
    expect(createdComment.get('commentableType')).toBe('Post')
    expect(createdComment.get('commentableId')).toBe(1)

    const draftPost = await postFactory
      .has(imageFactory, 'images')
      .hasAttached(tagFactory, 'tags', { active: true })
      .makeOne()
    expect(draftPost.getRelation<Entity<TableDefinition>[]>('images')).toHaveLength(2)
    expect(draftPost.getRelation<Entity<TableDefinition>[]>('images')[0]!.get('imageableType')).toBeUndefined()
    expect(draftPost.getRelation<Entity<TableDefinition>[]>('images')[0]!.get('imageableId')).toBeUndefined()

    const createdPost = await postFactory
      .has(imageFactory, 'images')
      .hasAttached(tagFactory, 'tags', { active: true })
      .createOne()

    expect(createdPost.getRelation<Entity<TableDefinition>[]>('images')).toHaveLength(2)
    expect(createdPost.getRelation<Entity<TableDefinition>[]>('images')[0]!.get('imageableType')).toBe('Post')
    expect(createdPost.getRelation<Entity<TableDefinition>[]>('tags')).toHaveLength(2)
    expect(createdPost.getRelation<Entity<TableDefinition>[]>('tags')[0]!.getRelation('pivot')).toMatchObject({
      taggableType: 'Post',
      taggableId: 2,
      tagId: 1,
      active: true })

    const taggedPostFactory = defineFactory(Post, () => ({ title: 'Tagged' }))
    const createdTag = await defineFactory(Tag, () => ({ name: 'Tag Root' }))
      .hasAttached(taggedPostFactory, 'posts', { active: false })
      .createOne()

    expect(createdTag.getRelation<Entity<TableDefinition>[]>('posts')).toHaveLength(1)
    expect(createdTag.getRelation<Entity<TableDefinition>[]>('posts')[0]!.getRelation('pivot')).toMatchObject({
      tagId: 3,
      taggableType: 'Post',
      taggableId: 3,
      active: false })

    expect(await db.table('images').orderBy('id').get()).toEqual([
      { id: 1, url: '/img-1.png', imageableType: 'Post', imageableId: 2 },
      { id: 2, url: '/img-2.png', imageableType: 'Post', imageableId: 2 },
    ])
    expect(await db.table('taggables').orderBy('id').get()).toEqual([
      { id: 1, tagId: 1, taggableType: 'Post', taggableId: 2, active: 1 },
      { id: 2, tagId: 2, taggableType: 'Post', taggableId: 2, active: 1 },
      { id: 3, tagId: 3, taggableType: 'Post', taggableId: 3, active: 0 },
    ])
  })

  it('fails fast for unsaved recycled and directly attached related models during create paths', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, teams)
    const users = defineTable('users', {
      id: column.id(),
      teamId: column.integer().nullable(),
      name: column.string() })
    await createTestTable(db, users)
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, roles)
    const roleUser = defineTable('roleUser', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })
    await createTestTable(db, roleUser)

    let Team!: ReturnType<typeof defineModelFromTable<typeof teams>>
    let User!: ReturnType<typeof defineModelFromTable<typeof users>>
    const Role = defineModelFromTable(roles, {
      fillable: ['name'],
      relations: {
        users: belongsToMany(() => User, {
          pivotTable: roleUser,
          foreignPivotKey: 'roleId',
          relatedPivotKey: 'userId',
          relatedKey: 'id' }) } })

    Team = defineModelFromTable(teams, {
      fillable: ['name'],
      relations: {
        users: hasMany(() => User, { foreignKey: 'teamId' }) } })
    User = defineModelFromTable(users, {
      fillable: ['teamId', 'name'],
      relations: {
        team: belongsTo(() => Team, { foreignKey: 'teamId', ownerKey: 'id' }),
        roles: belongsToMany(() => Role, {
          pivotTable: roleUser,
          foreignPivotKey: 'userId',
          relatedPivotKey: 'roleId',
          relatedKey: 'id' }) } })

    const teamFactory = defineFactory(Team, () => ({ name: 'Team' }))
    const roleFactory = defineFactory(Role, () => ({ name: 'Role' }))

    const unsavedRecycledTeam = Team.make({ name: 'Unsaved Team' })
    await expect(
      defineFactory(User, () => ({ name: 'Recycled User' }))
        .recycle(unsavedRecycledTeam)
        .for(teamFactory, 'team')
        .createOne(),
    ).rejects.toThrow('Factory.recycle() requires persisted related models when using create().')

    const unsavedRole = Role.make({ name: 'Unsaved Role' })
    await expect(
      defineFactory(User, () => ({ name: 'Recycled Attached User' }))
        .recycle(unsavedRole)
        .hasAttached(roleFactory.count(1), 'roles')
        .createOne(),
    ).rejects.toThrow('Factory.recycle() requires persisted related models when using create().')

    await expect(
      defineFactory(User, () => ({ name: 'Attached User' }))
        .hasAttached(unsavedRole, 'roles')
        .createOne(),
    ).rejects.toThrow('Relation-aware factories require persisted related models when attaching during create().')

    const zeroAttached = await defineFactory(User, () => ({ name: 'Zero' }))
      .hasAttached(roleFactory.count(0), 'roles')
      .createOne()
    expect(zeroAttached.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])
  })

  it('fails closed for unsupported relations and unsaved persisted relation sources', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, teams)
    const users = defineTable('users', {
      id: column.id(),
      teamId: column.integer().nullable(),
      name: column.string() })
    await createTestTable(db, users)
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, roles)
    const roleUser = defineTable('roleUser', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })
    await createTestTable(db, roleUser)

    const Team = defineModelFromTable(teams, { fillable: ['name'] })
    const Role = defineModelFromTable(roles, { fillable: ['name'] })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'teamId'],
      relations: {
        team: belongsTo(() => Team, 'teamId'),
        roles: belongsToMany(() => Role, roleUser, 'userId', 'roleId') } })

    const teamFactory = defineFactory(Team, () => ({ name: 'Core' }))
    const roleFactory = defineFactory(Role, () => ({ name: 'Admin' }))
    const userFactory = defineFactory(User, () => ({ name: 'Amina' }))

    await expect(userFactory.for(roleFactory, 'roles').createOne()).rejects.toThrow(SecurityError)
    await expect(userFactory.has(roleFactory, 'team').createOne()).rejects.toThrow(SecurityError)
    await expect(userFactory.hasAttached(teamFactory, 'team').createOne()).rejects.toThrow(SecurityError)

    await expect(
      userFactory.for(await teamFactory.makeOne(), 'team').createOne(),
    ).rejects.toThrow(HydrationError)

    await expect(
      userFactory.hasAttached([await roleFactory.makeOne()], 'roles').createOne(),
    ).rejects.toThrow(HydrationError)
  })

  it('supports hasOne and morphOne relation-aware factories', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer().nullable(),
      bio: column.string() })
    await createTestTable(db, profiles)
    const avatars = defineTable('avatars', {
      id: column.id(),
      imageableType: column.string().nullable(),
      imageableId: column.integer().nullable(),
      url: column.string() })
    await createTestTable(db, avatars)

    const Profile = defineModelFromTable(profiles, {
      fillable: ['userId', 'bio'] })
    const Avatar = defineModelFromTable(avatars, {
      fillable: ['imageableType', 'imageableId', 'url'] })
    const User = defineModelFromTable(users, {
      fillable: ['name'],
      relations: {
        profile: hasOne(() => Profile, 'userId'),
        avatar: morphOne(() => Avatar, 'imageable', 'imageableType', 'imageableId') } })

    const profileFactory = defineFactory(Profile, () => ({ bio: 'Bio' }))
    const avatarFactory = defineFactory(Avatar, () => ({ url: '/avatar.png' }))
    const userFactory = defineFactory(User, () => ({ name: 'Amina' }))
      .has(profileFactory, 'profile')
      .has(avatarFactory, 'avatar')

    const draft = await userFactory.makeOne()
    expect(draft.getRelation<Entity<TableDefinition>>('profile').get('userId')).toBeUndefined()
    expect(draft.getRelation<Entity<TableDefinition>>('avatar').get('imageableType')).toBeUndefined()

    const created = await userFactory.createOne()
    expect(created.getRelation<Entity<TableDefinition>>('profile').get('userId')).toBe(1)
    expect(created.getRelation<Entity<TableDefinition>>('avatar').get('imageableType')).toBe('User')
    expect(created.getRelation<Entity<TableDefinition>>('avatar').get('imageableId')).toBe(1)
  })
})
