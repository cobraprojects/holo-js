import { expectTypeOf, it } from 'vitest'
import {
  column,
  defineGeneratedTable,
  defineModel,
  type ModelQueryBuilder,
} from '../src'

const posts = defineGeneratedTable('scope_reuse_posts', {
  id: column.id(),
  status: column.string(),
  published_at: column.string(),
})

type PostQuery = ModelQueryBuilder<typeof posts>

const whereLive = (query: PostQuery) => query
  .where('status', 'published')
  .whereNotNull('published_at')

const Post = defineModel(posts, {
  scopes: {
    published: (query: PostQuery) => whereLive(query),
    recent: (query: PostQuery) => whereLive(query).orderBy('published_at', 'desc'),
    sibling: (query: PostQuery) => {
      // @ts-expect-error a scope's query parameter does not expose the sibling scopes
      return query.published()
    },
  },
})

it('shares scope constraints through a function typed against the builder', () => {
  if (false) {
    expectTypeOf(Post.recent()).toEqualTypeOf(Post.published().orderBy('published_at', 'desc'))
    expectTypeOf(Post.published().recent()).toEqualTypeOf(Post.published().orderBy('published_at', 'desc'))
  }
})
