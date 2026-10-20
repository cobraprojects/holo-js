import { it } from 'vitest'
import { column, defineGeneratedTable, defineModel, hasMany, scopeRelation } from '../src'

const posts = defineGeneratedTable('relation_constraint_posts', { id: column.id(), userId: column.integer(), title: column.string() })
const comments = defineGeneratedTable('relation_constraint_comments', { id: column.id(), postId: column.integer(), body: column.string() })

const Comment = defineModel(comments)
const Post = defineModel(posts, {
  relations: {
    comments: hasMany(() => Comment, 'postId'),
  },
})

it('types scoped relation constraints against the related model', () => {
  const scoped = scopeRelation(hasMany(() => Post, 'userId'), query => {
    query.where('title', '=', 'Hello')
    // @ts-expect-error body is a comments column, not a posts column
    query.where('body', '=', 'Hello')
  })
  void scoped
})

it('types lifecycle handlers against the model entity', () => {
  if (false) {
    defineModel(posts, {
      events: {
        saving: (entity) => {
          entity.get('title')
          // @ts-expect-error body is a comments column, not a posts column
          entity.get('body')
        },
      },
    })
    defineModel(comments, {
      events: {
        deleting: entity => {
          entity.get('body')
          // @ts-expect-error title is a posts column, not a comments column
          entity.get('title')
        },
      },
    })
  }
})
