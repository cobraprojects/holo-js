import { column, defineGeneratedTable, defineModel, hasMany } from '@holo-js/db'
import { expectTypeOf } from 'vitest'

const Post = defineModel(defineGeneratedTable('posts', {
  id: column.integer().primaryKey(),
  topicId: column.integer(),
  title: column.string(),
}), { timestamps: false, fillable: ['*', 'id'] })

const Topic = defineModel(defineGeneratedTable('topics', {
  id: column.integer().primaryKey(),
}), {
  relations: { posts: hasMany(() => Post, 'topicId') },
})

export async function findPost(id: number) {
  return await Post.query().where('id', id).first() ?? null
}

export async function findTopic(id: number) {
  return Topic.query().where('id', id).with('posts').withCount('posts').firstOrFail()
}

type FoundPost = Awaited<ReturnType<typeof findPost>>
expectTypeOf<Pick<NonNullable<FoundPost>, 'id' | 'title'>>().toEqualTypeOf<{ id: number, title: string }>()
expectTypeOf<Extract<FoundPost, null>>().toEqualTypeOf<null>()
expectTypeOf<Awaited<ReturnType<typeof findTopic>>['posts'][number]['title']>().toEqualTypeOf<string>()
expectTypeOf<ReturnType<Awaited<ReturnType<typeof findTopic>>['toAttributes']>['posts_count']>().toEqualTypeOf<number | undefined>()
