import { expectTypeOf, it } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, hasMany } from '../src'

const authors = defineGeneratedTable('order_alias_type_authors', { id: column.id(), name: column.string() })
const posts = defineGeneratedTable('order_alias_type_posts', { id: column.id(), author_id: column.integer(), score: column.integer(), published: column.boolean(), published_at: column.datetime() })

const Post = defineModel(posts)
const Author = defineModel(authors, { relations: { posts: hasMany(() => Post, 'author_id') } })

it('orders table queries by the aliases they select', async () => {
  if (false) {
    await DB.table(posts).select('author_id').addSelectSum('revenue', 'score').groupBy('author_id').orderByDesc('revenue').get()
    await DB.table(posts).select('author_id').addSelectCount('total').groupBy('author_id').orderBy('total', 'desc').latest('total').oldest('total').get()
    await DB.table(posts).select('score as points').orderBy('points').get()
    const subquery = DB.table(posts).selectMax('top', 'score') as never
    await DB.table(posts).selectDate('day', 'published_at', { as: 'day' }).addSelectSub(subquery, 'best').orderBy('day').get()
    // @ts-expect-error unselected aliases are not orderable
    await DB.table(posts).select('author_id').addSelectSum('revenue', 'score').orderBy('profit').get()
  }
})

it('orders model queries by the relation aggregates they load', async () => {
  if (false) {
    await Author.withCount('posts').orderByDesc('posts_count').get()
    await Author.withSum('posts', 'score').orderBy('posts_sum_score', 'desc').latest('posts_sum_score').oldest('posts_sum_score').reorder('posts_sum_score').get()
    await Author.withAggregate({ 'posts as published_posts': query => query.where('published', true) }, '*', 'count').orderByDesc('published_posts').get()
    await Author.withCount({ 'posts as published_posts': query => query.where('published', true) }).orderByDesc('published_posts').get()
    await Author.query().withExists('posts').orderBy('posts_exists').orderBy('name').paginate(15)
    // @ts-expect-error aggregates that are not loaded are not orderable
    await Author.withCount('posts').orderBy('posts_sum_score').get()
    // @ts-expect-error aggregates are only orderable once they are loaded
    await Author.query().orderBy('posts_count').get()
  }
})

it('types relation counts and existence keyed with an alias', async () => {
  if (false) {
    const author = await Author.withCount({ 'posts as published_posts': query => query.where('published', true) }).firstOrFail()
    expectTypeOf(author.toAttributes().published_posts).toEqualTypeOf<number | undefined>()
    const checked = await Author.query().withExists({ 'posts as has_published': query => query.where('published', true) }).firstOrFail()
    expectTypeOf(checked.toAttributes().has_published).toEqualTypeOf<boolean | undefined>()
    const named = await Author.withCount('posts as total_posts').withExists('posts AS has_posts').firstOrFail()
    expectTypeOf(named.toAttributes().total_posts).toEqualTypeOf<number | undefined>()
    expectTypeOf(named.toAttributes().has_posts).toEqualTypeOf<boolean | undefined>()
    await Author.withCount('posts as total_posts').orderByDesc('total_posts').get()
    // @ts-expect-error missing is not a relation of authors
    Author.withCount('missing as total')
    // @ts-expect-error missing is not a relation of authors
    Author.withCount({ 'missing as total': query => query })
    // @ts-expect-error missing is not a column of posts
    Author.withCount({ 'posts as total': query => query.where('missing', 1) })
  }
})
