'use server'

import { redirect } from 'next/navigation'
import { authorize } from '@holo-js/authorization'
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
  const status = String(formData.get('status') || 'published')
  await authorize('create', Post)
  if (status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status,
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
  redirect('/admin/posts')
}

export async function updatePostAction(id: number, formData: FormData) {
  await requireAdminAuth()
  const status = String(formData.get('status') || 'published')
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (status === 'published') {
    await authorize('publish', post)
  }

  await updatePost(id, {
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status,
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
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
  await authorize('manage', Category)

  await updateCategory(id, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number) {
  await requireAdminAuth()
  await authorize('manage', Category)

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
  await authorize('manage', Tag)

  await updateTag(id, { name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function deleteTagAction(id: number) {
  await requireAdminAuth()
  await authorize('manage', Tag)

  await deleteTag(id)
  redirect('/admin/tags')
}
