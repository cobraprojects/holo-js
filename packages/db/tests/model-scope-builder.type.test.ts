import { expectTypeOf, it } from 'vitest'
import {
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  ModelQueryBuilder as QueryBuilderConstructor,
  ModelRepository,
  scopeRelation,
  type TableQueryBuilder,
  type ModelQueryBuilder,
} from '../src'

const users = defineGeneratedTable('scope_type_users', { id: column.id(), name: column.string() })
const posts = defineGeneratedTable('scope_type_posts', {
  id: column.id(),
  user_id: column.integer(),
  title: column.string(),
  status: column.string(),
})

const Post = defineModel(posts, {
  scopes: {
    published: (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'published'),
    titled: (query: ModelQueryBuilder<typeof posts>, title: string) => query.where('title', title),
  },
})
const User = defineModel(users, {
  scopes: {
    named: (query: ModelQueryBuilder<typeof users>, name: string) => query.where('name', name),
  },
  relations: {
    posts: hasMany(() => Post, 'user_id'),
  },
})

type PostQuery = ModelQueryBuilder<typeof posts, typeof Post.definition.relations, unknown, typeof Post.definition.scopes>
type UserQuery = ModelQueryBuilder<typeof users, typeof User.definition.relations, unknown, typeof User.definition.scopes>

it('types named scopes on Model.query() with their parameter types', () => {
  if (false) {
    expectTypeOf(Post.query().published).toEqualTypeOf<() => PostQuery>()
    expectTypeOf(Post.query().titled).toEqualTypeOf<(title: string) => PostQuery>()
    // @ts-expect-error scope arguments are typed from the scope definition
    Post.query().titled(1)
    // @ts-expect-error scopes of other models are not available on this builder
    Post.query().named('Ada')
    // @ts-expect-error unknown scope names are rejected
    Post.query().missing()
  }
})

it('types named scopes on builders returned by Model.query() and other builder methods', () => {
  if (false) {
    expectTypeOf(Post.query().published()).toEqualTypeOf<PostQuery>()
    expectTypeOf(Post.query().where('title', '=', 'Hello').titled('Hello')).toEqualTypeOf<PostQuery>()
    expectTypeOf(Post.query().titled('Hello').orderBy('id').published()).toEqualTypeOf<PostQuery>()
    expectTypeOf(User.query().named('Ada')).toEqualTypeOf<UserQuery>()
    expectTypeOf(User.named('Ada')).toEqualTypeOf<UserQuery>()
    expectTypeOf(User.query().with('posts').named('Ada')).toEqualTypeOf(User.query().with('posts').where('name', '=', 'Ada'))
  }
})

it('types named scopes inside whereHas-family and with callbacks against the related model', () => {
  if (false) {
    User.whereHas('posts', (query) => {
      expectTypeOf(query.published).toEqualTypeOf<() => PostQuery>()
      expectTypeOf(query).toEqualTypeOf<PostQuery>()
      query.titled('Hello').published()
      // @ts-expect-error title parameter type comes from the scope definition
      query.titled(1)
    })
    User.query().with('posts', (query) => {
      expectTypeOf(query.published()).toEqualTypeOf<PostQuery>()
    })
    User.query().with({
      posts: (query) => {
        // @ts-expect-error the related model has no scope named `named`
        query.named('Ada')
      },
    })
    User.query().whereHas('posts', query => query.published())
    User.query().withWhereHas('posts', query => query.titled('Hello'))
    User.query().withCount({
      posts: (query) => {
        expectTypeOf(query.published).toEqualTypeOf<() => PostQuery>()
      },
    })
  }
})

it('rejects scope definitions that do not return a query builder', () => {
  if (false) {
    const Counter = defineModel(users, {
      scopes: {
        tally: (query: ModelQueryBuilder<typeof users>) => 5,
      },
    })
    // @ts-expect-error a scope must return a query builder, so its method has no builder return type
    Counter.tally()
  }
})

it('types scopes on the builder passed to scopeRelation constraints', () => {
  if (false) {
    scopeRelation(hasMany(() => Post, 'user_id'), (query) => {
      expectTypeOf(query.titled).toEqualTypeOf<(title: string) => PostQuery>()
      return query.published()
    })
  }
})

declare const postRepository: ModelRepository<typeof posts, typeof Post.definition.scopes>
declare const postTableQuery: TableQueryBuilder<typeof posts, Record<string, unknown>>

it('types scopes on repository builders and on the exported builder constructor', () => {
  if (false) {
    expectTypeOf(Post.getRepository().query().published()).toEqualTypeOf<PostQuery>()
    expectTypeOf(ModelRepository.from(Post).query().titled('Hello')).toEqualTypeOf<PostQuery>()
    expectTypeOf(new QueryBuilderConstructor(postRepository, postTableQuery).published()).toEqualTypeOf<PostQuery>()
  }
})

it('types a global scope callback written against the unscoped builder', () => {
  if (false) {
    const onlyDrafts = (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'draft')
    expectTypeOf(Post.query().applyGlobalScope(onlyDrafts)).toEqualTypeOf<PostQuery>()
  }
})

it('rejects scopes whose query parameter needs more than the builder provides', () => {
  if (false) {
    const Narrow = defineModel(posts, {
      scopes: {
        needsExtra: (query: ModelQueryBuilder<typeof posts> & { extra(): void }) => query,
      },
    })
    // @ts-expect-error the builder has no extra() method, so the scope cannot be called with it
    Narrow.query().needsExtra()
  }
})

it('rejects async scopes, whose result is a promise rather than a query builder', () => {
  if (false) {
    const Asynchronous = defineModel(posts, {
      scopes: {
        published: async (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'published'),
      },
    })
    // @ts-expect-error an async scope returns a promise, so it cannot be chained
    Asynchronous.query().published().where('status', 'published')
  }
})
