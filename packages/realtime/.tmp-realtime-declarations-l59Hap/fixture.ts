import { belongsToMany, column, defineGeneratedTable, defineModel } from '../../db/src/index'
import { query } from '../src/index'

const posts = defineGeneratedTable('posts', {
  id: column.id(),
  title: column.string(),
})

const tags = defineGeneratedTable('tags', {
  id: column.id(),
  name: column.string(),
})

const postTags = defineGeneratedTable('post_tags', {
  id: column.id(),
  postId: column.integer(),
  tagId: column.integer(),
})

const Tag = defineModel(tags)
const Post = defineModel(posts, {
  relations: {
    tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId'),
  },
})

export const adminPost = query({
  name: 'blog.admin.post',
  access: 'public',
  handler: async () => {
    const post = await Post.query().with('tags').first()
    return {
      post,
      tags: await Tag.query().get(),
    }
  },
})
