import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, latestMorphOne, latestOfMany, morphOne, morphTo, ofMany, resetDB } from '../src'
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
    table.string('title').nullable()
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
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer(), published: column.boolean(), title: column.string().nullable() })
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
  const authorType = `OaAuthor${tag}`
  await DB.table(likes).insert([
    { id: 1, likeable_type: authorType, likeable_id: 1 },
    { id: 2, likeable_type: authorType, likeable_id: 2 },
    { id: 3, likeable_type: authorType, likeable_id: 2 },
  ])
  const Author = defineModel(authors, {
    morphClass: authorType,
    timestamps: false,
    relations: {
      like: morphOne(() => Like, 'likeable'),
      posts: hasMany(() => Post, 'author_id'),
      latestPost: latestOfMany(() => Post, 'author_id'),
      topPost: ofMany(() => Post, 'author_id', 'score', 'max'),
      lowestPost: ofMany(() => Post, 'author_id', 'score', 'min'),
      latestLike: latestMorphOne(() => Like, 'likeable'),
      tags: belongsToMany(() => Tag, pivot, 'author_id', 'tag_id'),
    },
  })
  const StrictPost = defineModel(posts, { name: `StrictPost${tag}`, timestamps: false, preventAccessingMissingAttributes: true })
  const StrictAuthor = defineModel(authors, { name: `StrictAuthor${tag}`, timestamps: false, relations: { topPost: ofMany(() => StrictPost, 'author_id', 'score', 'max') } })
  const SiblingPost = defineModel(posts, { timestamps: false, relations: { latestSibling: latestOfMany(() => Post, 'author_id', 'author_id') } })
  return { Author, Like, SiblingPost, StrictAuthor, posts, pivot, names, schema }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('ordering by selected aliases on %s', (driver) => {
  it('orders table rows by an aggregate alias', async () => {
    const { posts } = await openAuthorsFixture(driver)

    const rows = await DB.table(posts).select('author_id').addSelectSum('revenue', 'score').groupBy('author_id').orderByDesc('revenue').get()
    expect(rows.map(row => [row.author_id, Number(row.revenue)])).toEqual([[2, 33], [1, 10]])
  })

  it('cursor paginates table rows by a selected column alias', async () => {
    const { posts } = await openAuthorsFixture(driver)
    const ordered = () => DB.table(posts).select('id', 'score as points').orderByDesc('points')

    const first = await ordered().cursorPaginate(2)
    const second = await ordered().cursorPaginate(2, first.nextCursor)

    expect(first.data.map(row => row.points)).toEqual([30, 10])
    expect(second.data.map(row => row.points)).toEqual([2, 1])
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

    await expect(Author.withCount('posts').orderByDesc('posts_count').cursorPaginate(2)).rejects.toThrow('Cursor pagination cannot order by the "posts_count" computed selection.')
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
    const { Author, Like, names } = await openAuthorsFixture(driver)

    await expect(Like.withCount('likeable').orderBy('likeable_count').get()).rejects.toThrow('Cannot order by the "likeable" relation aggregate')
    const reshaped = 'aggregate constraints that select, limit, offset, deduplicate, join, group or union the related rows cannot be ordered by.'
    await expect(Author.withSum({ posts: query => query.orderBy('score').limit(1) }, 'score').orderByDesc('posts_sum_score').get()).rejects.toThrow(reshaped)
    await expect(Author.withCount({ posts: query => query.select('author_id').distinct() }).orderByDesc('posts_count').get()).rejects.toThrow(reshaped)
    await expect(Author.withSum({ posts: query => query.select('id', 'author_id') }, 'score').orderByDesc('posts_sum_score').get()).rejects.toThrow(reshaped)
    await expect(Author.withCount({ posts: query => query.join(names.authors as never, `${names.authors}.id` as never, '=', `${names.posts}.author_id` as never) }).orderByDesc('posts_count').get()).rejects.toThrow(reshaped)
    await expect(Author.select('id', 'name as posts_count').withCount('posts').orderByDesc('posts_count').get()).rejects.toThrow('the query also selects a column named "posts_count"')
    await expect(Author.withCount('posts as name').orderByDesc('name').get()).rejects.toThrow('the query also selects a column named "name"')
    await expect(Author.select(`${names.authors}.*` as never).withCount('posts as name').orderByDesc('name').get()).rejects.toThrow('the query also selects a column named "name"')
  })

  it('orders by aggregates of ordered relations, counting every pivot row', async () => {
    const { Author, pivot } = await openAuthorsFixture(driver)
    await DB.table(pivot).insert([{ id: 4, author_id: 2, tag_id: 1 }, { id: 5, author_id: 2, tag_id: 1 }, { id: 6, author_id: 2, tag_id: 1 }])

    const tagged = await Author.withCount('tags').orderByDesc('tags_count').orderBy('id').get()
    expect(tagged.map(author => [author.id, author.toAttributes().tags_count])).toEqual([[2, 3], [3, 2], [1, 1]])

    const scored = await Author.whereHas('posts').withMax({ posts: query => query.orderBy('id') }, 'score').orderByDesc('posts_max_score').get()
    expect(scored.map(author => author.id)).toEqual([2, 1])
  })

  it('orders by the values the aggregates load for empty sums and single related rows', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const summed = await Author.withSum('posts', 'score').orderByDesc('posts_sum_score').orderBy('id').get()
    expect(summed.map(author => [author.id, author.toAttributes().posts_sum_score])).toEqual([[2, 33], [1, 10], [3, 0]])

    const liked = await Author.withCount('like').orderByDesc('like_count').orderBy('id').get()
    expect(liked.map(author => [author.id, author.toAttributes().like_count])).toEqual([[1, 1], [2, 1], [3, 0]])
  })

  it('orders by aggregates of boolean columns as the loader counts them', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const summed = await Author.withSum('posts', 'published').orderByDesc('posts_sum_published').orderBy('id').get()
    expect(summed.map(author => [author.id, author.toAttributes().posts_sum_published])).toEqual([[1, 1], [2, 1], [3, 0]])

    const averaged = await Author.whereHas('posts').withAvg('posts', 'published').orderBy('posts_avg_published').get()
    expect(averaged.map(author => author.id)).toEqual([2, 1])
  })

  it('orders by aggregates of the one row a one-of-many relation selects', async () => {
    const { Author } = await openAuthorsFixture(driver)
    const rows = (authors: readonly { id: number, toAttributes(): object }[], key: string) => authors.map(author => [author.id, (author.toAttributes() as Record<string, unknown>)[key]])

    expect(rows(await Author.withCount('latestPost').orderBy('latestPost_count').orderBy('id').get(), 'latestPost_count')).toEqual([[3, 0], [1, 1], [2, 1]])
    expect(rows(await Author.withExists('latestPost').orderByDesc('latestPost_exists').orderBy('id').get(), 'latestPost_exists')).toEqual([[1, true], [2, true], [3, false]])
    expect(rows(await Author.withSum('latestPost', 'score').orderByDesc('latestPost_sum_score').get(), 'latestPost_sum_score')).toEqual([[2, 30], [1, 10], [3, 0]])
    expect(rows(await Author.whereHas('posts').withMax('lowestPost', 'score').orderByDesc('lowestPost_max_score').get(), 'lowestPost_max_score')).toEqual([[1, 10], [2, 1]])
    expect(rows(await Author.whereHas('posts').withAvg('topPost', 'score').orderBy('topPost_avg_score').get(), 'topPost_avg_score')).toEqual([[1, 10], [2, 30]])
    expect(rows(await Author.withSum({ latestPost: query => query.where('published', false) }, 'score').orderByDesc('latestPost_sum_score').orderBy('id').get(), 'latestPost_sum_score')).toEqual([[2, 2], [1, 0], [3, 0]])
    expect(rows(await Author.withCount('latestLike').orderBy('latestLike_count').orderBy('id').get(), 'latestLike_count')).toEqual([[3, 0], [1, 1], [2, 1]])
  })

  it('orders by the selected one-of-many row, not by every related row', async () => {
    const { Author, posts, names } = await openAuthorsFixture(driver)
    await DB.table(posts).insert([{ id: 5, author_id: 1, score: 5, published: false }, { id: 6, author_id: 3, score: 8, published: false }])

    const summed = await Author.withSum('latestPost', 'score').orderByDesc('latestPost_sum_score').get()
    expect(summed.map(author => [author.id, author.toAttributes().latestPost_sum_score])).toEqual([[2, 30], [3, 8], [1, 5]])

    const counted = await Author.withCount('latestPost').orderByDesc('latestPost_count').orderBy('id').get()
    expect(counted.map(author => [author.id, author.toAttributes().latestPost_count])).toEqual([[1, 1], [2, 1], [3, 1]])

    const qualified = await Author.withCount({ latestPost: query => query.where(`${names.posts}.published` as never, true) }).orderByDesc('latestPost_count').orderBy('id').get()
    expect(qualified.map(author => [author.id, author.toAttributes().latestPost_count])).toEqual([[1, 1], [2, 1], [3, 0]])

    const either = await Author.withCount({ latestPost: query => query.where('published', true).orWhere('score', 99) }).orderByDesc('latestPost_count').orderBy('id').get()
    expect(either.map(author => [author.id, author.toAttributes().latestPost_count])).toEqual([[1, 1], [2, 1], [3, 0]])
  })

  it('breaks one-of-many ties by the primary key when loading and ordering', async () => {
    const { Author, posts } = await openAuthorsFixture(driver)
    await DB.table(posts).insert([{ id: 5, author_id: 1, score: 10, published: false }, { id: 6, author_id: 3, score: 15, published: false }])

    const ranked = await Author.withSum('topPost', 'score').withMax('topPost', 'id').orderByDesc('topPost_sum_score').get()
    expect(ranked.map(author => [author.id, author.toAttributes().topPost_sum_score, author.toAttributes().topPost_max_id])).toEqual([[2, 30, 4], [3, 15, 6], [1, 10, 5]])

    const loaded = await Author.with('topPost').findOrFail(1)
    expect(loaded.topPost?.id).toBe(5)
  })

  it('breaks one-of-many ties by the primary key for text extrema and projected loads', async () => {
    const { Author, StrictAuthor, posts } = await openAuthorsFixture(driver)
    await DB.table(posts).where('id', 1).update({ title: 'z' })
    await DB.table(posts).insert([{ id: 5, author_id: 1, score: 10, published: false, title: 'a' }, { id: 6, author_id: 3, score: 15, published: false, title: 'm' }])

    const titled = await Author.whereIn('id', [1, 3]).withMax('topPost', 'title').orderByDesc('topPost_max_title').get()
    expect(titled.map(author => [author.id, author.toAttributes().topPost_max_title])).toEqual([[3, 'm'], [1, 'a']])

    const projected = await StrictAuthor.with({ topPost: query => query.select('author_id', 'score') }).findOrFail(1)
    expect(projected.toJSON()).toMatchObject({ topPost: { author_id: 1, score: 10 } })
  })

  it('breaks one-of-many ties on UUID keys and ignores row locks in constraints', async () => {
    const { Author, names, schema } = await openAuthorsFixture(driver)
    const reviewsName = `${names.posts}_reviews`
    await schema.createTable(reviewsName, (table) => {
      table.uuid('id').primaryKey()
      table.integer('author_id')
      table.integer('score')
    })
    onTestFinished(() => schema.dropTable(reviewsName))
    const reviews = defineGeneratedTable(reviewsName, { id: column.uuid().primaryKey(), author_id: column.integer(), score: column.integer() })
    await DB.table(reviews).insert([
      { id: '00000000-0000-4000-8000-000000000001', author_id: 1, score: 7 },
      { id: '00000000-0000-4000-8000-000000000002', author_id: 1, score: 7 },
    ])
    const Review = defineModel(reviews, { timestamps: false })
    const Reviewed = defineModel(defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string() }), {
      name: `Reviewed${names.authors}`,
      timestamps: false,
      relations: { topReview: ofMany(() => Review, 'author_id', 'score', 'max') },
    })

    const reviewed = await Reviewed.with('topReview').findOrFail(1)
    expect(reviewed.toJSON()).toMatchObject({ topReview: { id: '00000000-0000-4000-8000-000000000002' } })

    const locked = await Author.with({ latestPost: query => query.lockForUpdate() }).findOrFail(2)
    expect(locked.toJSON()).toMatchObject({ latestPost: { id: 4 } })
  })

  it('orders by an aggregate of a one-of-many relation back to the same table', async () => {
    const { SiblingPost, posts: postsTable } = await openAuthorsFixture(driver)
    await DB.table(postsTable).insert([{ id: 5, author_id: 3, score: 20, published: true }])

    const posts = await SiblingPost.withSum('latestSibling', 'score').orderByDesc('latestSibling_sum_score').orderBy('id').get()
    expect(posts.map(post => [post.id, post.toAttributes().latestSibling_sum_score])).toEqual([[2, 30], [3, 30], [4, 30], [5, 20], [1, 10]])
  })

  it('orders by the last aggregate loaded under an alias', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const metrics = await Author.withCount('posts as metric').withSum('posts as metric', 'score').orderByDesc('metric').orderBy('id').get()
    expect(metrics.map(author => [author.id, author.toAttributes().metric])).toEqual([[2, 33], [1, 10], [3, 0]])
  })

  it('rejects cursor pagination by aggregate aliases and by aliases that shadow a column', async () => {
    const { posts } = await openAuthorsFixture(driver)

    await expect(DB.table(posts).select('author_id').addSelectCount('total').groupBy('author_id').orderBy('total').cursorPaginate(1))
      .rejects.toThrow('Cursor pagination cannot order by the "total" computed selection.')
    await expect(DB.table(posts).select('score as id').orderBy('id').cursorPaginate(1))
      .rejects.toThrow('Cursor pagination cannot order by the "id" alias because it shadows a "id" column.')
  })

  it('rejects ordering a union by a relation aggregate', async () => {
    const { Author } = await openAuthorsFixture(driver)

    await expect(Author.where('id', 1).unionAll(Author.where('id', 2)).withCount('posts').orderByDesc('posts_count').get())
      .rejects.toThrow('Cannot order a union of')
  })

  it('orders by the aggregate the query loads, whenever it is selected or replaced', async () => {
    const { Author } = await openAuthorsFixture(driver)

    const replaced = await Author.withCount('posts').orderByDesc('posts_count').withCount({ posts: query => query.where('published', false) }).orderBy('id').get()
    expect(replaced.map(author => [author.id, author.toAttributes().posts_count])).toEqual([[2, 2], [1, 0], [3, 0]])

    const selectedAfter = await Author.withCount('posts').orderByDesc('posts_count').select('id', 'name').get()
    expect(selectedAfter.map(author => [author.id, author.toAttributes().posts_count])).toEqual([[2, 3], [1, 1], [3, 0]])
  })
})
