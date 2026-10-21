import { expectTypeOf, it } from 'vitest'
import {
  belongsTo,
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  type ModelQueryBuilder,
  type ModelRelationName,
  type RelatedColumnNameForRelationPath,
  type RelationMap,
  type TableDefinition,
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
const Activity = defineMediaModel(defineModel(users, {
  relations: {
    posts: hasMany(() => Post, 'user_id'),
    comments: hasMany(() => Comment, 'post_id'),
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

it('types object-form aggregate callbacks per relation key against the related media model', () => {
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

it('checks object-form media aggregate columns against every relation key', () => {
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
    Activity.withSum({ posts: () => {} }, 'title')
    Activity.withMax({ comments: () => {} }, 'body')
    // @ts-expect-error body is a comments column, not a posts column
    Activity.withSum({ posts: () => {} }, 'body')
  }
})

it('types object-form media aggregate callbacks keyed with an alias against the related model', () => {
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

it('accepts the alias keyword in any case and with any whitespace, and rejects invalid alias relations', () => {
  if (false) {
    User.withSum({
      'posts AS total': (query) => {
        expectTypeOf(query).toEqualTypeOf<PostQuery>()
      },
    }, 'user_id')
    User.withSum({ '  posts\tAs\ntotal  ': () => {} }, 'user_id')
    User.withMax({ 'posts   as   total': () => {} }, 'id')
    // @ts-expect-error body is not a posts column, under any spelling of the alias
    User.withSum({ 'posts AS total': () => {} }, 'body')
    // @ts-expect-error missing is not a relation of users, under any spelling of the alias
    User.withSum({ 'missing As total': () => {} }, 'title')
    // @ts-expect-error missing is not a relation of users, under any spelling of the alias
    User.withMin({ 'missing   as   total': () => {} }, 'title')
  }
})

it('rejects an object type argument on object-form media aggregate calls, as core models do', () => {
  if (false) {
    const loads = { posts: () => {}, comments: () => {} }
    // @ts-expect-error an object type argument is not accepted by the object form
    Activity.withSum<{ posts: () => void }>(loads, 'title')
    // @ts-expect-error an object type argument is not accepted by the object form
    User.withSum<{ posts: () => void }>({ posts: () => {} }, 'title')
    const aliased = { 'posts as total': () => {}, 'comments as c': () => {} }
    // @ts-expect-error an object type argument is not accepted by the object form
    Activity.withSum<{ 'posts as total': () => void }>(aliased, 'title')
  }
})

it('keeps explicit key type arguments on object-form media aggregate calls compiling, as core models do', () => {
  if (false) {
    User.withSum<'posts'>({ posts: () => {} }, 'title')
    User.query().withAvg<'posts'>({ posts: () => {} }, 'user_id')
    Activity.withSum<'posts AS total'>({ 'posts AS total': () => {}, posts: () => {} }, 'user_id')
    // @ts-expect-error body is not a posts column, under an explicit key argument
    User.withSum<'posts'>({ posts: () => {} }, 'body')
    // @ts-expect-error a fresh literal with an extra key is rejected under an explicit key argument
    User.withSum<'posts'>({ posts: () => {}, missing: () => {} }, 'title')
  }
})

it('checks every key of an object held in a variable, including unions, numeric keys and invalid keys', () => {
  if (false) {
    const loads = { posts: () => {}, comments: () => {} }
    // @ts-expect-error title is a posts column that comments does not have
    Activity.withSum(loads, 'title')
    const narrow = { posts: () => {} }
    const wide = { posts: () => {}, comments: () => {} }
    const union: typeof narrow | typeof wide = wide
    // @ts-expect-error title is not a comments column, so the union member for comments rejects it
    Activity.withSum(union, 'title')
    const invalid = { posts: () => {}, missing: () => {} }
    // @ts-expect-error missing is not a relation of users
    User.withSum(invalid, 'title')
    const invalidUnion = { posts: () => {}, missing: () => {} } as { posts: () => void } | { posts: () => void, missing: () => void }
    // @ts-expect-error missing is not a relation of users, inside a union member
    User.withSum(invalidUnion, 'title')
    // @ts-expect-error missing is not a relation of users, through a spread
    User.withSum({ ...narrow, missing: () => {} }, 'title')
    // @ts-expect-error 123 is not a relation of users, even though runtime reads it as a key
    User.withSum({ posts: () => {}, 123: () => {} }, 'title')
    const broad: Record<string, () => void> = {}
    // @ts-expect-error a broad string index cannot prove every key is a relation
    User.withSum(broad, 'title')
    User.withSum({}, 'title')
  }
})

it('types object-form media aggregate columns across mixed alias and plain keys', () => {
  if (false) {
    Activity.withSum({
      'posts as total': () => {},
      comments: () => {},
    }, 'id')
    Activity.withSum({
      'posts as total': () => {},
      posts: () => {},
    }, 'id')
    // @ts-expect-error title is not a comments column, under a mixed alias and plain key object
    Activity.withSum({ 'posts as total': () => {}, comments: () => {} }, 'title')
  }
})

it('forwards generic relation maps into object-form media aggregate helpers', () => {
  if (false) {
    function forwardAggregates<TRelations extends RelationMap>(
      relations: TRelations,
      loads: Readonly<Partial<Record<ModelRelationName<TRelations>, () => void>>>,
      column: RelatedColumnNameForRelationPath<TRelations, ModelRelationName<TRelations>>,
    ) {
      const Model = defineMediaModel(defineModel(users, { relations }), {})
      Model.query().withSum(loads, column)
      Model.query().withMax(loads, column)
    }
    void forwardAggregates
  }
})
