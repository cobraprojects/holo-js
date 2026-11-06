import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, hasOneThrough, latestMorphOne, latestOfMany, morphMany, morphOne, morphTo, morphToMany, morphedByMany, resetDB, resetMorphRegistry, type ModelDefinitionLike } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Row = Record<string, unknown>

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function pick(rows: unknown, ...columns: string[]): unknown {
  const project = (row: Row | null) => row === null ? null : Object.fromEntries(columns.map(name => [name, row[name]]))
  return Array.isArray(rows)
    ? (rows as Row[]).map(project).sort((left, right) => Number(left?.id) - Number(right?.id))
    : project(rows as Row | null)
}

function idOf(row: unknown): unknown {
  return row === null ? null : (row as Row).id
}

async function openLibrary(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => {
    resetMorphRegistry()
    resetDB()
  })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    authors: `qk_authors_${suffix}`,
    posts: `qk_posts_${suffix}`,
    tags: `qk_tags_${suffix}`,
    postTag: `qk_post_tag_${suffix}`,
    comments: `qk_comments_${suffix}`,
    taggables: `qk_taggables_${suffix}`,
    reviews: `qk_reviews_${suffix}`,
  }
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  const create = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    created.push(name)
  }
  await create(names.authors, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await create(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.string('title')
  })
  await create(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('label')
  })
  await create(names.postTag, (table) => {
    table.integer('post_id')
    table.integer('tag_id')
  })
  await create(names.comments, (table) => {
    table.integer('id').primaryKey()
    table.string('commentable_type')
    table.integer('commentable_id')
    table.string('body')
  })
  await create(names.taggables, (table) => {
    table.integer('tag_id')
    table.string('taggable_type')
    table.integer('taggable_id')
  })
  await create(names.reviews, (table) => {
    table.integer('id').primaryKey()
    table.integer('post_id')
    table.string('body')
  })

  const authors = defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), title: column.string() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), label: column.string() })
  const comments = defineGeneratedTable(names.comments, { id: column.integer().primaryKey(), commentable_type: column.string(), commentable_id: column.integer(), body: column.string() })
  const reviews = defineGeneratedTable(names.reviews, { id: column.integer().primaryKey(), post_id: column.integer(), body: column.string() })
  const postType = `QkPost${suffix}`

  await DB.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
  await DB.table(posts).insert([{ id: 10, author_id: 1, title: 'Engines' }, { id: 11, author_id: 1, title: 'Notes' }, { id: 20, author_id: 2, title: 'Compilers' }])
  await DB.table(tags).insert([{ id: 100, label: 'math' }, { id: 200, label: 'code' }])
  await DB.table(names.postTag).insert([{ post_id: 10, tag_id: 100 }, { post_id: 20, tag_id: 200 }])
  await DB.table(comments).insert([
    { id: 1000, commentable_type: postType, commentable_id: 10, body: 'first' },
    { id: 1001, commentable_type: postType, commentable_id: 10, body: 'second' },
    { id: 2000, commentable_type: postType, commentable_id: 20, body: 'third' },
  ])
  await DB.table(names.taggables).insert([
    { tag_id: 100, taggable_type: postType, taggable_id: 10 },
    { tag_id: 200, taggable_type: postType, taggable_id: 10 },
    { tag_id: 200, taggable_type: postType, taggable_id: 20 },
  ])
  await DB.table(reviews).insert([{ id: 5000, post_id: 10, body: 'great' }, { id: 5001, post_id: 11, body: 'fine' }, { id: 6000, post_id: 20, body: 'sharp' }])

  const q = (table: string, name: string) => `${table}.${name}`
  const Review = defineModel(reviews, { timestamps: false })
  const Comment = defineModel(comments, {
    timestamps: false,
    relations: {
      commentable: morphTo('commentable', q(names.comments, 'commentable_type'), q(names.comments, 'commentable_id')),
      strayCommentable: morphTo('commentable', q(names.posts, 'commentable_type'), 'commentable_id'),
    },
  })
  const Tag = defineModel(tags, {
    timestamps: false,
    relations: {
      taggedPosts: morphedByMany((): ModelDefinitionLike => Post, 'taggable', names.taggables, q(names.taggables, 'tag_id'), q(names.tags, 'id'), q(names.posts, 'id'), q(names.taggables, 'taggable_type'), q(names.taggables, 'taggable_id')),
    },
  })
  const Post = defineModel(posts, {
    morphClass: postType,
    timestamps: false,
    relations: {
      author: belongsTo((): ModelDefinitionLike => Author, q(names.posts, 'author_id'), q(names.authors, 'id')),
      tags: belongsToMany(() => Tag, names.postTag, q(names.postTag, 'post_id'), q(names.postTag, 'tag_id'), q(names.posts, 'id'), q(names.tags, 'id')),
      comments: morphMany(() => Comment, 'commentable', q(names.comments, 'commentable_type'), q(names.comments, 'commentable_id'), q(names.posts, 'id')),
      firstComment: morphOne(() => Comment, 'commentable', q(names.comments, 'commentable_type'), q(names.comments, 'commentable_id'), q(names.posts, 'id')),
      latestComment: latestMorphOne(() => Comment, 'commentable', q(names.comments, 'id'), q(names.comments, 'commentable_type'), q(names.comments, 'commentable_id'), q(names.posts, 'id')),
      morphTags: morphToMany(() => Tag, 'taggable', names.taggables, q(names.taggables, 'tag_id'), q(names.posts, 'id'), q(names.tags, 'id'), q(names.taggables, 'taggable_type'), q(names.taggables, 'taggable_id')),
      strayAuthor: belongsTo((): ModelDefinitionLike => Author, q(names.tags, 'author_id'), 'id'),
      strayTags: belongsToMany(() => Tag, names.postTag, q(names.posts, 'post_id'), 'tag_id'),
      strayMorphTags: morphToMany(() => Tag, 'taggable', names.taggables, 'tag_id', 'id', 'id', 'taggable_type', q(names.tags, 'taggable_id')),
    },
  })
  const Author = defineModel(authors, {
    timestamps: false,
    relations: {
      topPost: hasOne(() => Post, q(names.posts, 'author_id'), q(names.authors, 'id')),
      posts: hasMany(() => Post, q(names.posts, 'author_id'), q(names.authors, 'id')),
      latestPost: latestOfMany(() => Post, q(names.posts, 'author_id'), q(names.authors, 'id'), q(names.posts, 'id')),
      reviews: hasManyThrough(() => Review, () => Post, q(names.posts, 'author_id'), q(names.reviews, 'post_id'), q(names.authors, 'id'), q(names.posts, 'id')),
      firstReview: hasOneThrough(() => Review, () => Post, q(names.posts, 'author_id'), q(names.reviews, 'post_id'), q(names.authors, 'id'), q(names.posts, 'id')),
      strayPost: hasOne(() => Post, q(names.tags, 'author_id'), 'id'),
      strayLocalPosts: hasMany(() => Post, 'author_id', q(names.posts, 'id')),
      strayReviews: hasManyThrough(() => Review, () => Post, 'author_id', 'post_id', 'id', q(names.reviews, 'id')),
    },
  })
  return { Author, Post, Comment, Tag, names }
}

describe.each(drivers)('relations with table-qualified keys on %s', (driver) => {
  it('eager loads hasOne, hasMany, latestOfMany, belongsTo and belongsToMany', async () => {
    const { Author, Post } = await openLibrary(driver)

    const loadedAuthors = plain(await Author.query().with('topPost', 'posts', 'latestPost').orderBy('id').get()) as Row[]
    expect([10, 11]).toContain(idOf(loadedAuthors[0]!.topPost))
    expect(idOf(loadedAuthors[1]!.topPost)).toBe(20)
    expect(loadedAuthors.map(author => pick(author.posts, 'id'))).toEqual([[{ id: 10 }, { id: 11 }], [{ id: 20 }]])
    expect(loadedAuthors.map(author => pick(author.latestPost, 'id'))).toEqual([{ id: 11 }, { id: 20 }])
    const loadedPosts = plain(await Post.query().with('author', 'tags').orderBy('id').get()) as Row[]
    expect(loadedPosts.map(post => pick(post.author, 'id', 'name'))).toEqual([{ id: 1, name: 'Ada' }, { id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
    expect(loadedPosts.map(post => pick(post.tags, 'id', 'label'))).toEqual([[{ id: 100, label: 'math' }], [], [{ id: 200, label: 'code' }]])
  })

  it('eager loads morphOne, morphMany, latestMorphOne, morphTo, morphToMany and morphedByMany', async () => {
    const { Post, Comment, Tag } = await openLibrary(driver)

    const loadedPosts = plain(await Post.query().with('comments', 'firstComment', 'latestComment', 'morphTags').orderBy('id').get()) as Row[]
    expect(loadedPosts.map(post => pick(post.comments, 'id'))).toEqual([[{ id: 1000 }, { id: 1001 }], [], [{ id: 2000 }]])
    expect([1000, 1001]).toContain(idOf(loadedPosts[0]!.firstComment))
    expect(loadedPosts.slice(1).map(post => idOf(post.firstComment))).toEqual([null, 2000])
    expect(loadedPosts.map(post => pick(post.latestComment, 'id'))).toEqual([{ id: 1001 }, null, { id: 2000 }])
    expect(loadedPosts.map(post => pick(post.morphTags, 'id'))).toEqual([[{ id: 100 }, { id: 200 }], [], [{ id: 200 }]])
    const loadedComments = plain(await Comment.query().with('commentable').orderBy('id').get()) as Row[]
    expect(loadedComments.map(comment => pick(comment.commentable, 'id', 'title'))).toEqual([{ id: 10, title: 'Engines' }, { id: 10, title: 'Engines' }, { id: 20, title: 'Compilers' }])
    const loadedTags = plain(await Tag.query().with('taggedPosts').orderBy('id').get()) as Row[]
    expect(loadedTags.map(tag => pick(tag.taggedPosts, 'id'))).toEqual([[{ id: 10 }], [{ id: 10 }, { id: 20 }]])
  })

  it('eager loads hasOneThrough and hasManyThrough', async () => {
    const { Author } = await openLibrary(driver)

    const loadedAuthors = plain(await Author.query().with('reviews', 'firstReview').orderBy('id').get()) as Row[]
    expect(loadedAuthors.map(author => pick(author.reviews, 'id'))).toEqual([[{ id: 5000 }, { id: 5001 }], [{ id: 6000 }]])
    expect([5000, 5001]).toContain(idOf(loadedAuthors[0]!.firstReview))
    expect(idOf(loadedAuthors[1]!.firstReview)).toBe(6000)
  })

  it('filters by relation existence with qualified keys', async () => {
    const { Author, Post, Tag } = await openLibrary(driver)

    expect(pick(plain(await Post.query().whereHas('comments').orderBy('id').get()), 'id')).toEqual([{ id: 10 }, { id: 20 }])
    expect(pick(plain(await Post.query().whereHas('morphTags', query => query.where('label', 'math')).get()), 'id')).toEqual([{ id: 10 }])
    expect(pick(plain(await Tag.query().whereHas('taggedPosts', query => query.where('id', 20)).get()), 'id')).toEqual([{ id: 200 }])
    expect(pick(plain(await Author.query().whereHas('reviews', query => query.where('body', 'sharp')).get()), 'id')).toEqual([{ id: 2 }])
  })

  it.each([
    ['Author', 'strayPost', 'foreignKey', 'qk_tags_'],
    ['Author', 'strayLocalPosts', 'localKey', 'qk_posts_'],
    ['Author', 'strayReviews', 'secondLocalKey', 'qk_reviews_'],
    ['Post', 'strayAuthor', 'foreignKey', 'qk_tags_'],
    ['Post', 'strayTags', 'foreignPivotKey', 'qk_posts_'],
    ['Post', 'strayMorphTags', 'morphIdColumn', 'qk_tags_'],
    ['Comment', 'strayCommentable', 'morphTypeColumn', 'qk_posts_'],
  ] as const)('rejects %s.%s whose %s is qualified with an unrelated table', async (model, relation, key, table) => {
    const models = await openLibrary(driver)

    const loader = models[model] as unknown as { query(): { with(name: string): { get(): Promise<unknown> } } }
    await expect(loader.query().with(relation).get()).rejects.toThrow(new RegExp(`"${relation}".*${key}.*"${table}`))
  })
})
