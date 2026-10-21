import { expectTypeOf, it } from 'vitest'
import {
  column,
  createModelCollection,
  defineGeneratedTable,
  defineModel,
  hasMany,
  type Entity,
  type ModelCollection,
  type ModelQueryBuilder,
  type RelationMap,
} from '../src'

const users = defineGeneratedTable('collection_scope_users', { id: column.id(), name: column.string() })
const posts = defineGeneratedTable('collection_scope_posts', {
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

it('types scopes on toQuery() for collections returned by static model methods', async () => {
  if (false) {
    const fromGet = await Post.get()
    const fromAll = await Post.all()
    expectTypeOf(fromGet.toQuery().published).toEqualTypeOf<() => PostQuery>()
    expectTypeOf(fromAll.toQuery().titled).toEqualTypeOf<(title: string) => PostQuery>()
    expectTypeOf(fromAll.toQuery().titled('Hello')).toEqualTypeOf<PostQuery>()
    // @ts-expect-error scope arguments are typed from the scope definition
    fromAll.toQuery().titled(1)
    // @ts-expect-error unknown scope names are rejected on the collection query
    fromGet.toQuery().missing()
    // @ts-expect-error scopes of other models are not available on this builder
    fromGet.toQuery().named('Ada')
  }
})

it('types scopes on toQuery() for collections returned by builder methods', async () => {
  if (false) {
    const fromBuilder = await Post.query().where('status', 'published').get()
    const fromScope = await Post.query().published().get()
    const fromLimited = await Post.query().titled('Hello').orderBy('id').limit(10).get()
    expectTypeOf(fromBuilder.toQuery().titled).toEqualTypeOf<(title: string) => PostQuery>()
    expectTypeOf(fromScope.toQuery().published).toEqualTypeOf<() => PostQuery>()
    expectTypeOf(fromLimited.toQuery().published()).toEqualTypeOf<PostQuery>()
    // @ts-expect-error the collection query exposes the scopes of the model that produced it
    fromLimited.toQuery().named('Ada')
  }
})

it('types scopes on toQuery() for collections returned by relation-loading builders', async () => {
  if (false) {
    const usersWithPosts = await User.query().with('posts').get()
    expectTypeOf(usersWithPosts.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(usersWithPosts.toQuery().named('Ada')).toEqualTypeOf<UserQuery>()
    // @ts-expect-error the loaded posts relation is not a method of the users query
    usersWithPosts.toQuery().posts()
  }
})

it('keeps scopes on collections returned by loading and collection helper methods', async () => {
  if (false) {
    const recent = await User.query().get()
    const loaded = await recent.load('posts')
    const loadedMissing = await recent.loadMissing('posts')
    const counted = await recent.loadCount('posts')
    const appended = recent.append('name')
    const visible = recent.makeVisible('name')
    const fresh = await recent.fresh()
    expectTypeOf(loaded.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(loadedMissing.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(counted.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(appended.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(visible.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    expectTypeOf(fresh.toQuery().named).toEqualTypeOf<(name: string) => UserQuery>()
    // @ts-expect-error unknown scope names are rejected after collection helpers
    loaded.toQuery().missing()
  }
})

it('types scopes on created and paginated collections', async () => {
  if (false) {
    const created = await Post.createMany([{ user_id: 1, title: 'Hello', status: 'published' }])
    expectTypeOf(created.toQuery().titled).toEqualTypeOf<(title: string) => PostQuery>()
    const page = await Post.paginate(10, 1)
    expectTypeOf(page.data.toQuery().published).toEqualTypeOf<() => PostQuery>()
  }
})

const Curated = defineModel(posts, {
  scopes: {
    published: (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'published'),
  },
  collection<TItem extends Entity<typeof posts>>(items: readonly TItem[]) {
    return createModelCollection<typeof posts, RelationMap, TItem>(items) as ModelCollection<typeof posts, RelationMap, TItem> & {
      emails(): string[]
    }
  },
})

it('keeps scopes on static model methods when the model has a custom collection', () => {
  if (false) {
    expectTypeOf(Curated.published()).toEqualTypeOf<ModelQueryBuilder<typeof posts, typeof Curated.definition.relations, unknown, typeof Curated.definition.scopes>>()
  }
})
