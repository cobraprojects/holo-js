import { authorize } from '@holo-js/authorization'
import { uniqueSlug } from '@holo-js/db'
import { mutation, query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

import Category from '../models/Category'
import Post from '../models/Post'
import Tag from '../models/Tag'

export const adminPosts = query({
  name: 'blog.admin.posts',
  access: 'authenticated',
  handler: async () => {
    await authorize('viewAny', Post)

    return {
      posts: await Post.with('category', 'tags').orderBy('created_at', 'desc').get(),
      categories: await Category.orderBy('name').get(),
      tags: await Tag.orderBy('name').get(),
    }
  },
})

export const renameAdminPost = mutation({
  name: 'blog.admin.posts.rename',
  args: schema({
    id: field.number().integer(),
    title: field.string().required('Title is required.').min(3),
  }),
  access: 'authenticated',
  handler: async ({ args }) => {
    const title = args.title.trim()
    const post = await Post.findOrFail(args.id)
    await authorize('update', post)
    await post.update({
      title,
      slug: await uniqueSlug(Post, title, { ignore: args.id }),
    })

    return {
      id: post.id,
      title,
    }
  },
})
