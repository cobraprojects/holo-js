'use server'

import { redirect } from 'next/navigation'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
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
import { requireAdminAuth } from './auth'

export async function createPostAction(formData: FormData) {
  await requireAdminAuth()
  const submission = await validate(formData, postForm)
  if (!submission.valid) {
    return submission.fail()
  }

  const data = submission.data
  const status = data.status
  await authorize('create', Post)
  if (status === 'published') {
    await authorize('publish', Post)
  }

  const result = await createPost({
    ...data,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })
  if (result.error) {
    return submission.fail({
      status: result.error.status,
      errors: {
        image: [result.error.message],
      },
    })
  }

  redirect('/admin/posts')
}

export async function updatePostAction(id: number, formData: FormData) {
  await requireAdminAuth()
  const submission = await validate(formData, postForm)
  if (!submission.valid) {
    return submission.fail()
  }

  const data = submission.data
  const status = data.status
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (status === 'published') {
    await authorize('publish', post)
  }

  const result = await updatePost(id, {
    ...data,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })
  if (result.error) {
    return submission.fail({
      status: result.error.status,
      errors: {
        image: [result.error.message],
      },
    })
  }

  redirect('/admin/posts')
}

export async function deletePostAction(id: number) {
  await requireAdminAuth()
  await authorize('delete', await Post.findOrFail(id))

  await deletePost(id)
  redirect('/admin/posts')
}

export async function createCategoryAction(formData: FormData) {
  await requireAdminAuth()
  await authorize('manage', Category)

  await createCategory({
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function updateCategoryAction(id: number, formData: FormData) {
  await requireAdminAuth()
  const category = await Category.findOrFail(id)
  await authorize('update', category)

  await updateCategory(id, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number) {
  await requireAdminAuth()
  const category = await Category.findOrFail(id)
  await authorize('delete', category)

  await deleteCategory(id)
  redirect('/admin/categories')
}

export async function createTagAction(formData: FormData) {
  await requireAdminAuth()
  await authorize('manage', Tag)

  await createTag({ name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function updateTagAction(id: number, formData: FormData) {
  await requireAdminAuth()
  const tag = await Tag.findOrFail(id)
  await authorize('update', tag)

  await updateTag(id, { name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function deleteTagAction(id: number) {
  await requireAdminAuth()
  const tag = await Tag.findOrFail(id)
  await authorize('delete', tag)

  await deleteTag(id)
  redirect('/admin/tags')
}
