import { expectTypeOf, it } from 'vitest'
import { column, defineGeneratedTable, defineModel, type ModelQueryBuilder } from '@holo-js/db'
import { defineMediaModel } from '../src'

const posts = defineGeneratedTable('media_scope_posts', {
  id: column.id(),
  status: column.string(),
  title: column.string(),
})

const Post = defineModel(posts, {
  scopes: {
    published: (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'published'),
    titled: (query: ModelQueryBuilder<typeof posts>, title: string) => query.where('title', title),
  },
})

const MediaPost = defineMediaModel(Post, {})

it('keeps model scopes on media-enabled static and query builder methods', () => {
  if (false) {
    MediaPost.query().published()
    MediaPost.published().titled('Hello')
    MediaPost.query().published().titled('Hello')
    MediaPost.query().where('status', 'draft').titled('Hello').published()
    expectTypeOf(MediaPost.query().titled).parameter(0).toEqualTypeOf<string>()
    // @ts-expect-error scope arguments are still typed from the scope definition
    MediaPost.query().titled(1)
    // @ts-expect-error unknown scope names are still rejected
    MediaPost.query().missing()
  }
})

it('keeps model scopes after media-enabled relation and aggregate helpers', () => {
  if (false) {
    MediaPost.query().withCount('media').published()
    MediaPost.query().with('media').titled('Hello')
    MediaPost.with('media').published()
    MediaPost.query().withCount('media').titled('Hello')
  }
})
