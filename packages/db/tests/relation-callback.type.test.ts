import { expectTypeOf, it } from 'vitest'
import type { RelatedColumnNameOfRelation } from '../src/model/types'
import {
  belongsTo,
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  type ModelQueryBuilder,
  type ModelRelationName,
  type ModelRelationPath,
  type RelationMap,
  type TableDefinition,
} from '../src'

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

const Activity = defineModel(users, {
  relations: {
    posts: hasMany(() => Post, 'user_id'),
    comments: hasMany(() => Comment, 'post_id'),
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

it('rejects object-form callback keys that are not relations of the model', () => {
  if (false) {
    User.with({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
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

it('accepts generic relation maps forwarded into eager-load and count callbacks', () => {
  if (false) {
    function forwardLoads<TRelations extends RelationMap>(
      query: ModelQueryBuilder<TableDefinition, TRelations>,
      loads: Readonly<Partial<Record<ModelRelationPath<TRelations>, () => void>>>,
      counts: Readonly<Partial<Record<Extract<keyof TRelations, string>, () => void>>>,
    ) {
      query.with(loads)
      query.withCount(counts)
      query.withExists(counts)
      // @ts-expect-error aggregate relations must be top-level names
      query.withCount(loads)
    }
    void forwardLoads
  }
})

it('restricts aggregate helpers to top-level relation names', () => {
  if (false) {
    // @ts-expect-error aggregate relations must be top-level names
    User.withSum('posts.comments', 'body')
    // @ts-expect-error aggregate relations must be top-level names
    User.withCount('posts.comments')
    // @ts-expect-error aggregate relations must be top-level names
    User.query().withExists({ 'posts.comments': () => {} })
    User.withSum('posts', 'title')
    User.query().withAvg('posts', 'title')
    User.withCount('posts')
    User.query().withExists({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    })
  }
})

it('types object-form aggregate callbacks per relation key against the related model', () => {
  if (false) {
    User.withSum({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
        query.where('title', '=', 'Hello')
        // @ts-expect-error body is a comments column, not a posts column
        query.where('body', '=', 'Hello')
      },
    }, 'title')
    User.query().withAvg({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    }, 'user_id')
    User.withMin({ posts: () => {} }, 'id')
    User.query().withMax({ posts: () => {} }, 'title')
    // @ts-expect-error body is a comments column, not a posts column
    User.withSum({ posts: () => {} }, 'body')
    // @ts-expect-error missing is not a relation of users
    User.withSum({ missing: () => {} }, 'title')
    // @ts-expect-error invalid nested key is rejected in object form
    User.withSum({ 'posts.comments': () => {} }, 'body')
    // @ts-expect-error missing is not a column of posts
    User.query().withAvg({ posts: () => {} }, 'missing')
  }
})

it('checks object-form aggregate columns against every relation key', () => {
  if (false) {
    Activity.withSum({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
      comments: (query) => {
        expectTypeOf(query).toEqualTypeOf<CommentQuery>()
        query.where('body', '=', 'Hello')
      },
    }, 'id')
    // @ts-expect-error title is a posts column that comments does not have
    Activity.withSum({ posts: () => {}, comments: () => {} }, 'title')
    // @ts-expect-error body is a comments column that posts does not have
    Activity.query().withMax({ posts: () => {}, comments: () => {} }, 'body')
    Activity.withMin({ posts: () => {}, comments: () => {} }, 'id')
    Activity.withSum('posts', 'title')
    Activity.withSum('comments', 'body')
  }
})

it('types object-form aggregate callbacks keyed with an alias against the related model', () => {
  if (false) {
    User.withSum({
      'posts as total': (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
        query.where('title', '=', 'Hello')
      },
    }, 'id')
    User.query().withMax({ 'posts as latest_title': () => {} }, 'title')
    // @ts-expect-error body is a comments column, not a posts column
    User.withSum({ 'posts as total': () => {} }, 'body')
    // @ts-expect-error missing is not a relation of users
    User.withSum({ 'missing as total': () => {} }, 'title')
    Activity.withSum({
      'posts as post_total': () => {},
      'comments as comment_total': () => {},
    }, 'id')
    // @ts-expect-error title is a posts column that comments does not have
    Activity.withSum({ 'posts as post_total': () => {}, 'comments as comment_total': () => {} }, 'title')
  }
})

it('checks object-form aggregate columns against every member of an object union', () => {
  if (false) {
    const narrow = { posts: () => {} }
    const wide = { posts: () => {}, comments: () => {} }
    const loads: typeof narrow | typeof wide = wide
    Activity.withSum(loads, 'id')
    // @ts-expect-error title is not a comments column, so the union member for comments rejects it
    Activity.withSum(loads, 'title')
    User.withSum({}, 'title')
  }
})

it('keeps object-form aggregate call shapes that compiled before', () => {
  if (false) {
    User.withSum<'posts'>({
      posts: (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    }, 'title')
    function takesLoads(loads: 'posts' | { posts: () => void }) {
      User.withSum(loads, 'title')
    }
    void takesLoads
    User.withSum({}, 'title')
    const opaque: object = { posts: () => {} }
    // @ts-expect-error body is not a posts column, and an opaque object does not widen the check
    User.withSum(opaque, 'body')
  }
})

it('keeps generic relation maps forwarded into object-form aggregate helpers', () => {
  if (false) {
    function forwardAggregates<TRelations extends RelationMap>(
      query: ModelQueryBuilder<TableDefinition, TRelations>,
      loads: Readonly<Partial<Record<ModelRelationName<TRelations>, () => void>>>,
      column: RelatedColumnNameOfRelation<TRelations[ModelRelationName<TRelations>]>,
    ) {
      query.withSum(loads, column)
      query.withMax(loads, column)
    }
    void forwardAggregates
  }
})

it('allows an explicit alias key with its base relation, and rejects keys outside the selected relation', () => {
  if (false) {
    User.withSum<'posts as total'>({
      'posts as total': () => {},
      posts: () => {},
    }, 'user_id')
    // @ts-expect-error comments is not the selected relation, so it cannot share the posts column
    User.withSum<'posts as total'>({ 'posts as total': () => {}, comments: () => {} }, 'user_id')
    // @ts-expect-error comments is not the selected relation, even under the explicit name
    Activity.withMax<'posts'>({ posts: () => {}, comments: () => {} }, 'id')
  }
})
