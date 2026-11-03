import { expectTypeOf, it } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel } from '../src'

const posts = defineGeneratedTable('wildcard_posts', { id: column.id(), title: column.string() })
const stats = defineGeneratedTable('wildcard_post_stats', { post_id: column.integer(), views: column.integer() })
const Post = defineModel(posts)

it('selects every column of the model table and of joined tables with table.*', () => {
  if (false) {
    Post.query().select('wildcard_posts.*')
    Post.query().join('wildcard_post_stats', 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id').select('wildcard_posts.*', 'wildcard_post_stats.*')
    Post.query().leftJoin('wildcard_post_stats', 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id').addSelect('wildcard_post_stats.*')
    // @ts-expect-error a table that is neither the model table nor joined is rejected
    Post.query().select('wildcard_post_stats.*')
    // @ts-expect-error unknown tables are rejected
    Post.query().select('foo.*')
    // @ts-expect-error unknown columns are rejected
    Post.query().select('missing')
  }
})

it('types the row of a table.* selection from the table columns', async () => {
  if (false) {
    const row = await DB.table(posts)
      .join(stats, 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id')
      .select('wildcard_posts.*', 'wildcard_post_stats.views as viewCount')
      .first()
    expectTypeOf(row).toEqualTypeOf<{ id: number, title: string, viewCount: number } | undefined>()
    const joinedRow = await DB.table(posts)
      .join(stats, 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id')
      .select('wildcard_post_stats.*')
      .first()
    expectTypeOf(joinedRow).toEqualTypeOf<{ post_id: number, views: number } | undefined>()
    // @ts-expect-error unknown tables are rejected
    DB.table(posts).select('foo.*')
    // @ts-expect-error a table that is not joined is rejected
    DB.table(posts).select('wildcard_post_stats.*')
    // @ts-expect-error unknown columns are rejected
    DB.table(posts).select('missing')
  }
})

it('types a table.* selection of a definition without a join and of a model exactly', async () => {
  if (false) {
    const row = await DB.table(posts).select('wildcard_posts.*').first()
    expectTypeOf(row).toEqualTypeOf<{ id: number, title: string } | undefined>()
    const joinedByName = await DB.table(posts)
      .join('wildcard_post_stats', 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id')
      .select('wildcard_posts.*')
      .first()
    expectTypeOf(joinedByName).toEqualTypeOf<{ id: number, title: string } | undefined>()
    const post = await Post.query().select('wildcard_posts.*').firstOrFail()
    expectTypeOf(post.get('title')).toEqualTypeOf<string>()
    expectTypeOf(post.get('id')).toEqualTypeOf<number>()
  }
})

it('types a table.* selection of a table name as an untyped row', async () => {
  if (false) {
    const row = await DB.table('wildcard_posts').select('wildcard_posts.*').first()
    expectTypeOf(row).toEqualTypeOf<Record<string, unknown> | undefined>()
    expectTypeOf(row!.title).toEqualTypeOf<unknown>()
    const joined = await DB.table('wildcard_posts')
      .join('wildcard_post_stats', 'wildcard_post_stats.post_id', '=', 'wildcard_posts.id')
      .select('wildcard_posts.*')
      .first()
    expectTypeOf(joined).toEqualTypeOf<Record<string, unknown> | undefined>()
    const aliased = await DB.table('wildcard_posts').select('wildcard_posts.*', 'wildcard_posts.id as postId').first()
    expectTypeOf(aliased!.title).toEqualTypeOf<unknown>()
    expectTypeOf(aliased!.postId).toEqualTypeOf<unknown>()
  }
})
