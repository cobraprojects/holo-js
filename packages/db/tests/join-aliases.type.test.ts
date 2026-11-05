import { expectTypeOf, it } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel } from '../src'

const posts = defineGeneratedTable('alias_join_posts', { id: column.id(), title: column.string(), parent_id: column.integer().nullable() })
const Post = defineModel(posts)

it('keeps the source columns typed through an aliased self-join', async () => {
  if (false) {
    const row = await DB.table(posts)
      .join('alias_join_posts as parent', 'parent.id', '=', 'alias_join_posts.parent_id')
      .select('alias_join_posts.*', 'parent.title as parentTitle')
      .first()
    expectTypeOf(row).toEqualTypeOf<{ id: number, title: string, parent_id: number | null, parentTitle: unknown } | undefined>()
    const twin = await DB.table(posts)
      .leftJoin('alias_join_posts as twin', 'twin.id', '=', 'alias_join_posts.parent_id')
      .select('alias_join_posts.title', 'twin.*')
      .first()
    expectTypeOf(twin!.title).toEqualTypeOf<string>()
    expectTypeOf(twin!.anything).toEqualTypeOf<unknown>()
  }
})

it('lets a model select every column of an aliased join by its alias', () => {
  if (false) {
    Post.query().join('alias_join_posts as parent', 'parent.id', '=', 'alias_join_posts.parent_id').select('alias_join_posts.*', 'parent.*')
    Post.query().leftJoin('alias_join_posts AS parent', 'parent.id', '=', 'alias_join_posts.parent_id').select('parent.*')
    Post.query().rightJoin('alias_join_posts as parent', 'parent.id', '=', 'alias_join_posts.parent_id').select('parent.*')
    Post.query().crossJoin('alias_join_posts as parent').select('parent.*')
    // @ts-expect-error an alias of several words is not an alias
    Post.query().join('alias_join_posts as bad alias', 'parent.id', '=', 'alias_join_posts.parent_id').select('bad alias.*')
    // @ts-expect-error the joined table is reachable only through its alias
    Post.query().join('alias_join_posts as parent', 'parent.id', '=', 'alias_join_posts.parent_id').select('alias_join_posts as parent.*')
  }
})

it('reads aliases around any whitespace and keeps each member of a union of join targets', () => {
  if (false) {
    Post.query().crossJoin('alias_join_posts as\tparent').select('parent.*')
    Post.query().crossJoin('alias_join_posts\nas parent\t').select('parent.*')
    const target = Math.random() > 0.5 ? 'alias_join_authors' : 'alias_join_authors as parent'
    const query = Post.query().crossJoin(target)
    query.select('alias_join_authors.*')
    query.select('parent.*')
  }
})
