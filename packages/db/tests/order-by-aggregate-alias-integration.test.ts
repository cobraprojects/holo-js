import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, latestOfMany, morphTo, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'

async function openAuthorsFixture(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { authors: `oa_authors_${tag}`, posts: `oa_posts_${tag}`, tags: `oa_tags_${tag}`, pivot: `oa_author_tags_${tag}`, likes: `oa_likes_${tag}` }
  const createTable = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    onTestFinished(() => schema.dropTable(name))
  }
  await createTable(names.authors, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await createTable(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.integer('score')
    table.boolean('published')
  })
  await createTable(names.tags, (table) => {
    table.integer('id').primaryKey()
  })
  await createTable(names.pivot, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.integer('tag_id')
  })
  await createTable(names.likes, (table) => {
    table.integer('id').primaryKey()
    table.string('likeable_type')
    table.integer('likeable_id')
  })

  const authors = defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer(), published: column.boolean() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey() })
  const pivot = defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), author_id: column.integer(), tag_id: column.integer() })
  const likes = defineGeneratedTable(names.likes, { id: column.integer().primaryKey(), likeable_type: column.string(), likeable_id: column.integer() })

  await DB.table(authors).insert([{ id: 1, name: 'ada' }, { id: 2, name: 'bob' }, { id: 3, name: 'cy' }])
  await DB.table(posts).insert([
    { id: 1, author_id: 1, score: 10, published: true },
    { id: 2, author_id: 2, score: 1, published: false },
    { id: 3, author_id: 2, score: 2, published: false },
    { id: 4, author_id: 2, score: 30, published: true },
  ])
  await DB.table(tags).insert([{ id: 1 }, { id: 2 }])
  await DB.table(pivot).insert([{ id: 1, author_id: 3, tag_id: 1 }, { id: 2, author_id: 3, tag_id: 2 }, { id: 3, author_id: 1, tag_id: 1 }])

  const Post = defineModel(posts, { timestamps: false })
  const Tag = defineModel(tags, { timestamps: false })
  const Like = defineModel(likes, { timestamps: false, relations: { likeable: morphTo('likeable') } })
  const Author = defineModel(authors, {
    timestamps: false,
    relations: {
      posts: hasMany(() => Post, 'author_id'),
      latestPost: latestOfMany(() => Post, 'author_id'),
      tags: belongsToMany(() => Tag, pivot, 'author_id', 'tag_id'),
    },
  })
  return { Author, Like, posts }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('ordering by selected aliases on %s', (driver) => {
  it('orders table rows by an aggregate alias', async () => {
    const { posts } = await openAuthorsFixture(driver)

    const rows = await DB.table(posts).select('author_id').addSelectSum('revenue', 'score').groupBy('author_id').orderByDesc('revenue').get()
    expect(rows.map(row => [row.author_id, Number(row.revenue)])).toEqual([[2, 33], [1, 10]])
  })

  it('orders, limits and paginates models by a relation count', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const authors = await Author.withCount('posts').orderByDesc('posts_count').get()
    expect(authors.map(author => [author.id, author.toAttributes().posts_count])).toEqual([[2, 3], [1, 1], [3, 0]])
    expect(authors.every(author => !author.isDirty())).toBe(true)

    const top = await Author.withCount('posts').orderByDesc('posts_count').first()
    expect(top?.id).toBe(2)

    const page = await Author.withCount('posts').orderBy('posts_count').paginate(2, 1)
    expect(page.data.map(author => author.id)).toEqual([3, 1])
    expect(page.meta.total).toBe(3)
  })

  it('chunks models in relation aggregate order and rejects cursor pagination by it', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const chunked: number[] = []
    await Author.withCount('posts').orderByDesc('posts_count').chunk(2, (authors) => {
      chunked.push(...authors.map(author => author.id))
    })
    expect(chunked).toEqual([2, 1, 3])

    await expect(Author.withCount('posts').orderByDesc('posts_count').cursorPaginate(2)).rejects.toThrow('Cursor pagination cannot order by the "posts_count" subquery selection.')
  })

  it('orders models by column aggregates', async () => {
    const { Author } = await openAuthorsFixture(driver)
    const ordered = async (query: { get(): Promise<readonly { id: number }[]> }) => (await query.get()).map(author => author.id)

    expect(await ordered(Author.whereHas('posts').withSum('posts', 'score').orderByDesc('posts_sum_score'))).toEqual([2, 1])
    expect(await ordered(Author.whereHas('posts').withAvg('posts', 'score').orderBy('posts_avg_score'))).toEqual([1, 2])
    expect(await ordered(Author.whereHas('posts').withMin('posts', 'score').orderByDesc('posts_min_score'))).toEqual([1, 2])
    expect(await ordered(Author.whereHas('posts').withMax('posts', 'score').latest('posts_max_score'))).toEqual([2, 1])
    const summed = await Author.whereHas('posts').withSum('posts', 'score').orderByDesc('posts_sum_score').get()
    expect(summed.map(author => author.toAttributes().posts_sum_score)).toEqual([33, 10])
  })

  it('orders models by relation existence, constrained aliases and pivot relations', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const existing = await Author.withExists('posts').orderBy('posts_exists').orderBy('id').get()
    expect(existing.map(author => [author.id, author.toAttributes().posts_exists])).toEqual([[3, false], [1, true], [2, true]])

    const published = await Author.withCount({ 'posts as published_posts': query => query.where('published', true) }).orderByDesc('published_posts').orderBy('id').get()
    expect(published.map(author => [author.id, author.toAttributes().published_posts])).toEqual([[1, 1], [2, 1], [3, 0]])

    const tagged = await Author.withCount('tags').orderByDesc('tags_count').get()
    expect(tagged.map(author => author.id)).toEqual([3, 1, 2])
  })

  it('rejects ordering by aggregates the query cannot compute', async () => {
    const { Author, Like } = await openAuthorsFixture(driver)

    expect(() => Like.withCount('likeable').orderBy('likeable_count')).toThrow('Cannot order by the "likeable" relation aggregate')
    expect(() => Author.withCount('latestPost').orderBy('latestPost_count')).toThrow('Cannot order by the "latestPost" relation aggregate')
  })
})
