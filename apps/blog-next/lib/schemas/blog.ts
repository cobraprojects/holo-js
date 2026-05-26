import { field, schema } from '@holo-js/forms/schema'

export const postForm = schema({
  title: field.string().required('Title is required.'),
  excerpt: field.string().optional(),
  body: field.string().required('Body is required.'),
  status: field.string().required('Select a valid post status.').in(['draft', 'published'], 'Select a valid post status.'),
  categoryId: field.string().optional(),
  tagIds: field.array(field.number()).default([]),
  image: field.file().optional().image('The selected file must be an image.').maxSize('2mb', 'The selected file must be 2 MB or smaller.'),
})
