'use server'

import { redirect } from 'next/navigation'
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

export async function createPostAction(formData: FormData) {
  await createPost({
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status: String(formData.get('status') || 'published'),
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
  redirect('/admin/posts')
}

export async function updatePostAction(id: number, formData: FormData) {
  await updatePost(id, {
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status: String(formData.get('status') || 'published'),
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
  redirect('/admin/posts')
}

export async function deletePostAction(id: number) {
  await deletePost(id)
  redirect('/admin/posts')
}

export async function createCategoryAction(formData: FormData) {
  await createCategory({
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function updateCategoryAction(id: number, formData: FormData) {
  await updateCategory(id, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || ''),
  })
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number) {
  await deleteCategory(id)
  redirect('/admin/categories')
}

export async function createTagAction(formData: FormData) {
  await createTag({ name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function updateTagAction(id: number, formData: FormData) {
  await updateTag(id, { name: String(formData.get('name') || '') })
  redirect('/admin/tags')
}

export async function deleteTagAction(id: number) {
  await deleteTag(id)
  redirect('/admin/tags')
}
