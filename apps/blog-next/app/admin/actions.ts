'use server'

import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { isValidationException } from '@holo-js/validation'
import { postForm } from '@/lib/schemas/blog'
import {
  createPost,
  updatePost,
  deletePost,
  createCategory,
  updateCategory,
  deleteCategory,
  createTag,
  updateTag,
  deleteTag,
} from '@/server/lib/blog'
import Category from '@/server/models/Category'
import Post from '@/server/models/Post'
import Tag from '@/server/models/Tag'

export async function createPostAction(formData: FormData) {
  try {
    const currentAuth = await auth()
    if (!currentAuth.authenticated || !currentAuth.user) {
      redirect('/login')
    }
    await authorize('viewAny', Post)

    const data = await validate(formData, postForm)
    const status = data.status
    await authorize('create', Post)
    if (status === 'published') {
      await authorize('publish', Post)
    }

    await createPost({
      ...data,
      authorId: currentAuth.user.id,
      tagIds: data.tagIds.join(','),
      ...(data.image?.size ? { image: data.image } : {}),
    })

    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}

export async function updatePostAction(id: number, formData: FormData) {
  try {
    const currentAuth = await auth()
    if (!currentAuth.authenticated || !currentAuth.user) {
      redirect('/login')
    }
    await authorize('viewAny', Post)

    const data = await validate(formData, postForm)
    const status = data.status
    const post = await Post.findOrFail(id)
    await authorize('update', post)
    if (status === 'published') {
      await authorize('publish', post)
    }

    await updatePost(id, {
      ...data,
      tagIds: data.tagIds.join(','),
      ...(data.image?.size ? { image: data.image } : {}),
    })

    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}

export async function deletePostAction(id: number) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  await authorize('delete', await Post.findOrFail(id))

  await deletePost(id)
  redirect('/admin/posts')
}

export async function createCategoryAction(formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  await authorize('manage', Category)

  await createCategory({
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function updateCategoryAction(id: number, formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  const category = await Category.findOrFail(id)
  await authorize('update', category)

  await updateCategory(id, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  const category = await Category.findOrFail(id)
  await authorize('delete', category)

  await deleteCategory(id)
  redirect('/admin/categories')
}

export async function createTagAction(formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  await authorize('manage', Tag)

  await createTag({ name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function updateTagAction(id: number, formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  const tag = await Tag.findOrFail(id)
  await authorize('update', tag)

  await updateTag(id, { name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function deleteTagAction(id: number) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)
  const tag = await Tag.findOrFail(id)
  await authorize('delete', tag)

  await deleteTag(id)
  redirect('/admin/tags')
}
