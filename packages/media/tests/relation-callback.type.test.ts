import { expectTypeOf, it } from 'vitest'
import {
  belongsTo,
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  type ModelQueryBuilder,
} from '@holo-js/db'
import { defineMediaModel } from '../src'

const users = defineGeneratedTable('media_relation_callback_users', { id: column.id(), name: column.string() })
const posts = defineGeneratedTable('media_relation_callback_posts', { id: column.id(), user_id: column.integer(), title: column.string() })
const comments = defineGeneratedTable('media_relation_callback_comments', { id: column.id(), post_id: column.integer(), body: column.string() })

const Comment = defineMediaModel(defineModel(comments), {})
const Post = defineMediaModel(defineModel(posts, {
  relations: {
    comments: hasMany(() => Comment, 'post_id'),
  },
}), {})
const User = defineMediaModel(defineModel(users, {
  relations: {
    posts: hasMany(() => Post, 'user_id'),
  },
}), {})
const Author = defineMediaModel(defineModel(users), {})
const Article = defineMediaModel(defineModel(posts, {
  relations: {
    author: belongsTo(() => Author, 'user_id'),
  },
}), {})

type CommentQuery = ModelQueryBuilder<typeof comments, typeof Comment.definition.relations>
type PostQuery = ModelQueryBuilder<typeof posts, typeof Post.definition.relations>

it('types with(path, callback) against the related media model builder', () => {
  if (false) {
    User.with('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
      query.where('title', '=', 'Hello')
      // @ts-expect-error body is a comments column, not a posts column
      query.where('body', '=', 'Hello')
    })
    User.query().with('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
    })
  }
})

it('types nested with(path, callback) against the leaf related model builder', () => {
  if (false) {
    User.with('posts.comments', (query) => {
      expectTypeOf(query).toEqualTypeOf<CommentQuery>()
      query.where('body', '=', 'Hello')
      // @ts-expect-error title is a posts column, not a comments column
      query.where('title', '=', 'Hello')
    })
    // @ts-expect-error invalid nested relation names are still rejected with a callback
    User.with('posts.missing', (query) => query)
  }
})

it('types whereHas-family callbacks against the related media model builder', () => {
  if (false) {
    User.whereHas('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
      query.where('title', '=', 'Hello')
      // @ts-expect-error body is a comments column, not a posts column
      query.where('body', '=', 'Hello')
    })
    User.orWhereHas('posts', (query) => {
      // @ts-expect-error body is a comments column, not a posts column
      query.where('body', '=', 'Hello')
    })
    User.whereDoesntHave('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
    })
    User.orWhereDoesntHave('posts.comments', (query) => {
      expectTypeOf(query).toEqualTypeOf<CommentQuery>()
    })
    User.query().whereHas('posts.comments', (query) => {
      expectTypeOf(query).toEqualTypeOf<CommentQuery>()
      query.where('body', '=', 'Hello')
    })
    User.query().withWhereHas('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
    })
  }
})

it('types object-form eager and count callbacks per relation key', () => {
  if (false) {
    User.with({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
        // @ts-expect-error body is a comments column, not a posts column
        query.where('body', '=', 'Hello')
      },
    })
    User.withCount({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
    User.query().withExists({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
  }
})

it('rejects object-form callback keys that are not relations of the model', () => {
  if (false) {
    // @ts-expect-error missing is not a relation of users
    User.with({ posts: () => {}, missing: () => {} })
    // @ts-expect-error missing is not a relation of users
    User.withCount({ missing: () => {} })
    // @ts-expect-error missing is not a relation of users
    User.query().withExists({ missing: () => {} })
    // @ts-expect-error invalid nested key is rejected in object form
    User.with({ 'posts.missing': () => {} })
  }
})

it('keeps relation callbacks on related models typed through belongsTo', () => {
  if (false) {
    Article.with('author', (query) => {
      expectTypeOf(query).toEqualTypeOf<ModelQueryBuilder<typeof users, typeof Author.definition.relations>>()
      query.where('name', '=', 'Ada')
    })
  }
})

it('types aggregate helper callbacks against the related media model builder', () => {
  if (false) {
    User.withSum('posts', 'title')
    User.query().withAvg('posts', 'title')
    User.withCount('posts')
    User.query().withExists({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
    User.withSum({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    }, 'title')
    User.withMax({ posts: () => {} }, 'title')
    User.withCount({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
    // @ts-expect-error body is a comments column, not a posts column
    User.withSum('posts', 'body')
  }
})

it('restricts aggregate helpers to top-level relation names', () => {
  if (false) {
    // @ts-expect-error aggregate relations must be top-level names
    User.withSum('posts.comments', 'body')
    // @ts-expect-error aggregate relations must be top-level names
    User.query().withAvg('posts.comments', 'body')
    // @ts-expect-error aggregate relations must be top-level names
    User.withMin('posts.comments', 'body')
    // @ts-expect-error aggregate relations must be top-level names
    User.withCount('posts.comments')
    // @ts-expect-error aggregate relations must be top-level names
    User.query().withExists({ 'posts.comments': () => {} })
    const nestedLoads = { posts: () => {}, 'posts.comments': () => {} }
    // @ts-expect-error aggregate relations must be top-level names, even when the object is held in a variable
    User.withCount(nestedLoads)
    // @ts-expect-error aggregate relations must be top-level names, even when the object is held in a variable
    User.query().withExists(nestedLoads)
    // @ts-expect-error aggregate relations must be top-level names, even when the object is held in a variable
    User.withSum(nestedLoads, 'title')
    // @ts-expect-error aggregate helpers require a relation name
    User.withCount()
    // @ts-expect-error aggregate helpers require a relation name
    User.query().withExists()
  }
})

it('types whereRelation and orWhereRelation columns against the related media model', () => {
  if (false) {
    User.whereRelation('posts', 'title', '=', 'Hello')
    User.orWhereRelation('posts', 'title', '=', 'Hello')
    // @ts-expect-error body is a comments column, not a posts column
    User.whereRelation('posts', 'body', '=', 'Hello')
    // @ts-expect-error body is a comments column, not a posts column
    User.orWhereRelation('posts', 'body', '=', 'Hello')
    User.query().whereRelation('posts.comments', 'body', '=', 'Hello')
    User.query().orWhereRelation('posts.comments', 'body', '=', 'Hello')
    // @ts-expect-error title is a posts column, not a comments column
    User.whereRelation('posts.comments', 'title', '=', 'Hello')
    // @ts-expect-error title is a posts column, not a comments column
    User.query().orWhereRelation('posts.comments', 'title', '=', 'Hello')
    // @ts-expect-error nope is not a column of posts
    User.whereRelation('posts', 'nope', '=', 'Hello')
    // @ts-expect-error missing is not a relation of users
    User.whereRelation('missing', 'title', '=', 'Hello')
  }
})

it('keeps media-enabled callbacks after whereRelation', () => {
  if (false) {
    User.query()
      .whereRelation('posts', 'title', '=', 'Hello')
      .with('posts', (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      })
    User.query()
      .orWhereRelation('posts', 'title', '=', 'Hello')
      .with('posts', (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      })
  }
})
