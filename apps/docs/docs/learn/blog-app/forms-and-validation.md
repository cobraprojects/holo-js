# Forms and Validation

This chapter validates the admin post form before writes reach the domain layer.

## What you will build

- a typed post form schema
- validation errors for required fields
- allowed status values
- image file validation
- validation error responses from server actions

## Files you will create

```txt
lib/schemas/blog.ts
app/admin/posts/post-form.jsx
app/admin/actions.ts
server/lib/validation-response.ts
```

The finished example uses:

- `apps/blog-next/lib/schemas/blog.ts`
- `apps/blog-next/app/admin/posts/post-form.jsx`
- `apps/blog-next/server/lib/validation-response.ts`

## Post schema

```ts
import { field, schema } from '@holo-js/forms/schema'

export const postForm = schema({
  title: field.string().required('Title is required.').min(3),
  excerpt: field.string().optional(),
  body: field.string().required('Body is required.'),
  status: field.string().required('Select a valid post status.').in(['draft', 'published'], 'Select a valid post status.'),
  categoryId: field.string().optional(),
  tagIds: field.array(field.number()).default([]),
  image: field.file().optional().image('The selected file must be an image.').maxSize('2mb', 'The selected file must be 2 MB or smaller.'),
})
```

## Action validation

```ts
try {
  const data = await validate(formData, postForm)
  await createPost({
    ...data,
    authorId: currentAuth.user.id,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })
} catch (error) {
  if (isValidationException(error)) {
    return error.toJSON()
  }

  throw error
}
```

## Checkpoint

Invalid admin input returns field errors instead of creating bad content. The next chapter adds login and session protection.

## Related reference

- [Forms Overview](/forms/)
- [Server Validation](/forms/server-validation)
- [Validation Rules And Errors](/validation/rules-and-errors)
