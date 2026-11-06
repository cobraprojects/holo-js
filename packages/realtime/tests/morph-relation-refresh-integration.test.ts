import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable, defineModel, hasMany, latestMorphOne, morphedByMany, morphMany, morphOne, morphTo, morphToMany, resetMorphRegistry, type ModelDefinitionLike } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

async function openBlog(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => {
    resetRealtimeRuntime()
    resetMorphRegistry()
  })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    posts: `holo_mr_posts_${suffix}`,
    comments: `holo_mr_comments_${suffix}`,
    tags: `holo_mr_tags_${suffix}`,
    taggables: `holo_mr_taggables_${suffix}`,
  }
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  const create = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    created.push(name)
  }
  await create(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.string('title')
  })
  await create(names.comments, (table) => {
    table.integer('id').primaryKey()
    table.string('commentable_type')
    table.integer('commentable_id')
    table.string('body')
  })
  await create(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('label')
  })
  await create(names.taggables, (table) => {
    table.integer('tag_id')
    table.string('taggable_type')
    table.integer('taggable_id')
  })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), title: column.string() })
  const comments = defineGeneratedTable(names.comments, { id: column.integer().primaryKey(), commentable_type: column.string(), commentable_id: column.integer(), body: column.string() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), label: column.string() })
  const postType = `HoloMrPost${suffix}`
  await db.table(posts).insert([{ id: 10, title: 'Engines' }, { id: 20, title: 'Compilers' }])
  await db.table(comments).insert([{ id: 100, commentable_type: postType, commentable_id: 10, body: 'first' }, { id: 200, commentable_type: postType, commentable_id: 20, body: 'second' }])
  await db.table(tags).insert([{ id: 1, label: 'math' }, { id: 2, label: 'code' }])
  await db.table(names.taggables).insert([{ tag_id: 1, taggable_type: postType, taggable_id: 10 }, { tag_id: 2, taggable_type: postType, taggable_id: 20 }])

  const Comment = defineModel(comments, { timestamps: false, relations: { commentable: morphTo('commentable') } })
  const Tag = defineModel(tags, {
    timestamps: false,
    relations: { taggedPosts: morphedByMany((): ModelDefinitionLike => Post, 'taggable', names.taggables, 'tag_id') },
  })
  const Post = defineModel(posts, {
    morphClass: postType,
    timestamps: false,
    relations: {
      comments: morphMany(() => Comment, 'commentable'),
      plainComments: hasMany(() => Comment, 'commentable_id'),
      firstComment: morphOne(() => Comment, 'commentable'),
      latestComment: latestMorphOne(() => Comment, 'commentable'),
      morphTags: morphToMany(() => Tag, 'taggable', names.taggables, 'tag_id'),
    },
  })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, names, posts, comments, tags, postType, Post, Comment, Tag }
}

async function subscribeMorphReads({ db, Post, Comment, Tag }: Awaited<ReturnType<typeof openBlog>>) {
  const reads: Record<string, () => Promise<unknown>> = {
    commentable: () => db.model(Comment).query().with('commentable').orderBy('id').getJson(),
    comments: () => db.model(Post).query().with('comments', 'firstComment', 'latestComment').orderBy('id').getJson(),
    mixedComments: () => db.model(Post).query().with('comments', 'plainComments').orderBy('id').getJson(),
    morphTags: () => db.model(Post).query().with('morphTags').orderBy('id').getJson(),
    taggedPosts: () => db.model(Tag).query().with('taggedPosts').orderBy('id').getJson(),
  }
  const current: Record<string, () => unknown> = {}
  for (const [name, handler] of Object.entries(reads)) {
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    current[name] = () => subscription.current.data
  }
  const mutate = async (step: string, handler: () => Promise<unknown>) => {
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
    for (const [name, read] of Object.entries(reads)) {
      expect(current[name]!(), `${name} after ${step}`).toEqual(await read())
    }
  }
  return { current, mutate }
}

async function seedFrequencyHopping({ db, names, posts, comments, tags, postType }: Awaited<ReturnType<typeof openBlog>>) {
  await db.table(posts).insert({ id: 30, title: 'Frequency Hopping' })
  await db.table(comments).insert({ id: 300, commentable_type: postType, commentable_id: 30, body: 'radio' })
  await db.table(tags).insert({ id: 3, label: 'radio' })
  await db.table(names.taggables).insert({ tag_id: 3, taggable_type: postType, taggable_id: 30 })
}

describe.each(drivers)('realtime morph relations on %s', (driver) => {
  describe('keeps every morph relation subscription equal to a fresh read', () => {
    it('after updating a post, a tag and a comment', async () => {
      const blog = await openBlog(driver)
      const { db, posts, comments, tags } = blog
      const { current, mutate } = await subscribeMorphReads(blog)

      await mutate('updating a post', () => db.table(posts).where('id', 10).update({ title: 'Analytical Engines' }))
      expect(JSON.stringify(current.commentable!())).toContain('Analytical Engines')
      expect(JSON.stringify(current.taggedPosts!())).toContain('Analytical Engines')
      await mutate('updating a tag', () => db.table(tags).where('id', 1).update({ label: 'mathematics' }))
      expect(JSON.stringify(current.morphTags!())).toContain('mathematics')
      await mutate('updating a comment', () => db.table(comments).where('id', 100).update({ body: 'edited' }))
      expect(JSON.stringify(current.comments!())).toContain('edited')
    })

    it('after inserting a post, a comment, a tag and a pivot row', async () => {
      const blog = await openBlog(driver)
      const { db, names, posts, comments, tags, postType } = blog
      const { current, mutate } = await subscribeMorphReads(blog)

      await mutate('inserting a post', () => db.table(posts).insert({ id: 30, title: 'Frequency Hopping' }))
      await mutate('inserting a comment', () => db.table(comments).insert({ id: 300, commentable_type: postType, commentable_id: 30, body: 'radio' }))
      await mutate('inserting a tag', () => db.table(tags).insert({ id: 3, label: 'radio' }))
      await mutate('inserting a pivot row', () => db.table(names.taggables).insert({ tag_id: 3, taggable_type: postType, taggable_id: 30 }))
      expect(JSON.stringify(current.taggedPosts!())).toContain('Frequency Hopping')
    })

    it('after rows reference a post and a tag that are inserted later', async () => {
      const blog = await openBlog(driver)
      const { db, names, posts, comments, tags, postType } = blog
      const { current, mutate } = await subscribeMorphReads(blog)

      await mutate('commenting on a missing post', () => db.table(comments).insert({ id: 400, commentable_type: postType, commentable_id: 40, body: 'early' }))
      await mutate('tagging a missing post', () => db.table(names.taggables).insert({ tag_id: 1, taggable_type: postType, taggable_id: 40 }))
      await mutate('tagging with a missing tag', () => db.table(names.taggables).insert({ tag_id: 4, taggable_type: postType, taggable_id: 10 }))
      await mutate('inserting the missing post', () => db.table(posts).insert({ id: 40, title: 'Spread Spectrum' }))
      expect((current.commentable!() as { id: number, commentable: unknown }[]).find(comment => comment.id === 400)?.commentable).toEqual({ id: 40, title: 'Spread Spectrum' })
      expect(JSON.stringify(current.taggedPosts!())).toContain('Spread Spectrum')
      await mutate('inserting the missing tag', () => db.table(tags).insert({ id: 4, label: 'signals' }))
      expect(JSON.stringify(current.morphTags!())).toContain('signals')
    })

    it('after moving and retyping rows until a post is unreferenced and deleted', async () => {
      const blog = await openBlog(driver)
      const { db, names, posts, comments } = blog
      await seedFrequencyHopping(blog)
      const { current, mutate } = await subscribeMorphReads(blog)

      await mutate('updating a pivot row', () => db.table(names.taggables).where('tag_id', 2).update({ taggable_id: 30 }))
      await mutate('moving a comment', () => db.table(comments).where('id', 200).update({ commentable_id: 30 }))
      await mutate('retyping a pivot row', () => db.table(names.taggables).where('tag_id', 2).update({ taggable_type: 'HoloMrOther' }))
      await mutate('deleting an unreferenced post', () => db.table(posts).where('id', 20).delete())
      expect(JSON.stringify(current.comments!())).not.toContain('Compilers')
    })

    it('after deleting pivot rows, comments, tags and a referenced post', async () => {
      const blog = await openBlog(driver)
      const { db, names, posts, comments, tags, postType } = blog
      await seedFrequencyHopping(blog)
      await db.table(comments).where('id', 200).update({ commentable_id: 30 })
      const { current, mutate } = await subscribeMorphReads(blog)

      await mutate('deleting a pivot row', () => db.table(names.taggables).where('tag_id', 1).delete())
      await mutate('deleting a comment', () => db.table(comments).where('id', 300).delete())
      await mutate('deleting a tag', () => db.table(tags).where('id', 3).delete())
      await mutate('tagging a post again', () => db.table(names.taggables).insert({ tag_id: 1, taggable_type: postType, taggable_id: 30 }))
      expect(JSON.stringify(current.taggedPosts!())).toContain('Frequency Hopping')
      await mutate('deleting a referenced post', () => db.table(posts).where('id', 30).delete())
      expect((current.commentable!() as { id: number, commentable: unknown }[]).find(comment => comment.id === 200)?.commentable).toBeNull()
      expect(JSON.stringify(current.taggedPosts!())).not.toContain('Frequency Hopping')
    })
  })

  it('keeps a subscription that morph-loads a relation equal to a fresh read', async () => {
    const { db, posts, comments, postType, Comment } = await openBlog(driver)
    const reads: Record<string, () => Promise<unknown>> = {
      loadMorph: async () => {
        const comment = await db.model(Comment).query().orderBy('id').first()
        return (await comment!.loadMorph('commentable', {})).toJSON()
      },
      nestedLoadMorph: async () => {
        const comment = await db.model(Comment).query().orderBy('id').first()
        return (await comment!.loadMorph('commentable', { [postType]: ['comments'] })).toJSON()
      },
    }
    const current: Record<string, () => unknown> = {}
    for (const [name, handler] of Object.entries(reads)) {
      const subscription = await subscribeRealtimeQuery(
        defineRealtimeQuery({ access: 'public', handler }),
        {},
        { onData: () => {}, onError: (error) => { throw error } },
      )
      current[name] = () => subscription.current.data
    }
    const mutate = async (step: string, handler: () => Promise<unknown>) => {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
      for (const [name, read] of Object.entries(reads)) {
        expect(current[name]!(), `${name} after ${step}`).toEqual(JSON.parse(JSON.stringify(await read())))
      }
    }

    await mutate('updating the post', () => db.table(posts).where('id', 10).update({ title: 'Analytical Engines' }))
    expect(current.loadMorph!()).toMatchObject({ id: 100, body: 'first', commentable: { id: 10, title: 'Analytical Engines' } })
    await mutate('inserting a comment on the post', () => db.table(comments).insert({ id: 300, commentable_type: postType, commentable_id: 10, body: 'more' }))
    expect(JSON.stringify(current.nestedLoadMorph!())).toContain('more')
    await mutate('deleting the post', () => db.table(posts).where('id', 10).delete())
    expect(current.loadMorph!()).toMatchObject({ id: 100, commentable: null })
  })
})
