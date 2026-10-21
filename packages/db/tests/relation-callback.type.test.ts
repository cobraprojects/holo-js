import { expectTypeOf, it } from 'vitest'
import { belongsTo, column, defineGeneratedTable, defineModel, hasMany, type ModelQueryBuilder } from '../src'

const users = defineGeneratedTable('relation_callback_users', { id: column.id(), name: column.string() })
const posts = defineGeneratedTable('relation_callback_posts', { id: column.id(), user_id: column.integer(), title: column.string() })
const comments = defineGeneratedTable('relation_callback_comments', { id: column.id(), post_id: column.integer(), body: column.string() })

const Comment = defineModel(comments)
const Post = defineModel(posts, {
  relations: {
    comments: hasMany(() => Comment, 'post_id'),
  },
})
const User = defineModel(users, {
  relations: {
    posts: hasMany(() => Post, 'user_id'),
  },
})
const Author = defineModel(users)
const Article = defineModel(posts, {
  relations: {
    author: belongsTo(() => Author, 'user_id'),
  },
})

type CommentQuery = ModelQueryBuilder<typeof comments, typeof Comment.definition.relations>
type PostQuery = ModelQueryBuilder<typeof posts, typeof Post.definition.relations>
type UserQuery = ModelQueryBuilder<typeof users, typeof User.definition.relations>

it('types with(path, callback) against the related model builder', () => {
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

it('types whereHas-family callbacks against the related model builder', () => {
  if (false) {
    User.whereHas('posts', (query) => {
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
      query.where('title', '=', 'Hello')
      query.applyGlobalScope(scope => scope.where('title', '=', 'Hello'))
      // @ts-expect-error body is a comments column, not a posts column
      query.applyGlobalScope(scope => scope.where('body', '=', 'Hello'))
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

it('types nested relation filter columns against the leaf related model', () => {
  if (false) {
    User.whereRelation('posts.comments', 'body', '=', 'Hello')
    // @ts-expect-error title is a posts column, not a comments column
    User.whereRelation('posts.comments', 'title', '=', 'Hello')
    User.with({
      'posts.comments': (query) => {
        expectTypeOf(query).toEqualTypeOf<CommentQuery>()
      },
    })
  }
})

it('keeps relation callbacks on related models typed through belongsTo and wider builders', () => {
  if (false) {
    Article.with('author', (query) => {
      expectTypeOf(query).toEqualTypeOf<ModelQueryBuilder<typeof users, typeof Author.definition.relations>>()
      query.where('name', '=', 'Ada')
    })
    const wide: ModelQueryBuilder<typeof posts> = Post.query()
    wide.whereHas('comments', (query) => {
      query.where('body', '=', 'Hello')
    })
    const userQuery: UserQuery = User.query()
    void userQuery
  }
})
