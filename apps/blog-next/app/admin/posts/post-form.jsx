'use client'

import { useForm } from '@holo-js/adapter-next/client'
import Image from 'next/image'
import { postForm } from '@/lib/schemas/blog'

export function PostForm({ action, data, imagePath, post, submitLabel }) {
  const form = useForm(postForm, {
    validateOn: 'blur',
    initialValues: {
      title: post?.title ?? '',
      excerpt: post?.excerpt ?? '',
      body: post?.body ?? '',
      status: post?.status ?? 'published',
      categoryId: post?.category_id ? String(post.category_id) : '',
      tagIds: post?.tags?.map(tag => tag.id) ?? [],
    },
    async submitter({ formData }) {
      return await action(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }} style={{ display: 'grid', gap: '1rem' }}>
      <input name="title" value={form.values.title} onInput={(event) => form.fields.title.onInput(event.currentTarget.value)} onBlur={() => form.fields.title.onBlur()} placeholder="Title" required />
      {form.errors.has('title') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('title')}</span> : null}
      <textarea name="excerpt" value={form.values.excerpt ?? ''} onInput={(event) => form.fields.excerpt.onInput(event.currentTarget.value)} rows={3} placeholder="Excerpt" />
      <textarea name="body" value={form.values.body} onInput={(event) => form.fields.body.onInput(event.currentTarget.value)} onBlur={() => form.fields.body.onBlur()} rows={10} placeholder="Body" required />
      {form.errors.has('body') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('body')}</span> : null}
      {imagePath ? <Image src={imagePath} alt="" width={448} height={252} style={{ width: '100%', maxWidth: '28rem', height: 'auto', borderRadius: '0.75rem' }} /> : null}
      <input name="image" type="file" accept="image/png,image/jpeg,image/webp" />
      {form.errors.has('image') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('image')}</span> : null}
      <select name="categoryId" value={form.values.categoryId ?? ''} onChange={(event) => form.fields.categoryId.onInput(event.currentTarget.value)}>
        <option value="">Uncategorized</option>
        {data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <fieldset style={{ border: '1px solid rgba(148, 163, 184, 0.2)', padding: '0.75rem', borderRadius: '0.5rem' }}>
        <legend style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Tags</legend>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {data.tags.map(tag => (
            <label key={tag.id} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', color: '#cbd5e1' }}>
              <input type="checkbox" name="tagIds" value={tag.id} defaultChecked={form.values.tagIds.includes(tag.id)} />
              {tag.name}
            </label>
          ))}
        </div>
      </fieldset>
      <select name="status" value={form.values.status} onChange={(event) => form.fields.status.onInput(event.currentTarget.value)}>
        <option value="published">Published</option>
        <option value="draft">Draft</option>
      </select>
      <button type="submit" disabled={form.submitting}>{submitLabel}</button>
    </form>
  )
}
