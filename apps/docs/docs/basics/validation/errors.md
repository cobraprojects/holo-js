# Error Messages

When validation fails, Holo collects messages for each field into an **error bag** and sends them to the client as a 422 response. This page covers the response format, custom messages, reading errors, and adding your own errors from business logic.

## The 422 response

When `validate()` throws inside a route handler, Holo responds with status 422 and this JSON body:

```json
{
  "ok": false,
  "status": 422,
  "valid": false,
  "message": "email: This field must be a valid email address.",
  "bag": "default",
  "values": {
    "email": "ava@example",
    "remember": true
  },
  "errors": {
    "email": ["This field must be a valid email address."],
    "address.city": ["This field is required."]
  }
}
```

- `errors` maps each field path to its messages. Nested fields use dots (`address.city`) and array items use their index (`tags.0`).
- `values` echoes the submitted input so a form can show it again. Uploaded files, passwords, and [sensitive](/basics/validation/rules#sensitive) fields are left out, including inside nested objects and lists.
- `message` is the first error, prefixed with its field path.
- `bag` names the error bag. It is `default` unless you choose another one.

[`useForm()`](/basics/forms/client) reads this shape automatically, so you rarely parse it by hand.

## How each framework responds

You don't need to catch `ValidationException` yourself. Holo handles it in each framework:

| Framework | Where you throw | What the client gets |
|---|---|---|
| Next.js | Route handler (`app/**/route.ts`) | 422 JSON response |
| Next.js | Server action | The error reaches `useForm()`, which shows the field errors |
| Nuxt | `server/api/**` or a request that doesn't accept HTML | 422 JSON response |
| Nuxt | `server/routes/**` from a native HTML form post | 303 redirect back to the form, with errors flashed for [`useValidationErrors()`](/basics/forms/frameworks#native-forms-in-nuxt) |
| SvelteKit | `+server.ts` | 422 JSON response |
| SvelteKit | Form action in `+page.server.ts` | Errors flashed for `useForm()` and `useValidationErrors()` on the page, passed as `pageData` from the root layout load |

## Default messages

These are the messages you get when you don't pass your own:

| Rule | Default message |
|---|---|
| `required()` | This field is required. |
| `string()` / `password()` | This field must be text. |
| `number()` | This field must be a number. |
| `boolean()` | This field must be true or false. |
| `date()` | This field must be a valid date. |
| `file()` | The selected file must be a file. |
| `array()` | This field must be a list. |
| `min(n)` | This field must be at least n characters. / must contain at least n items. / must be n or greater. |
| `max(n)` | This field must be n characters or fewer. / must contain n items or fewer. / must be n or less. |
| `size(n)` | This field must be exactly n characters. / must contain exactly n items. / must be exactly n. |
| `max()` / `maxSize()` on files | The selected file must be 2 MB or smaller (bytes if you pass a number). |
| `size()` on files | The selected file must be exactly 2 MB (or the byte count you pass). |
| `email()` | This field must be a valid email address. |
| `url()` | This field must be a valid URL. |
| `uuid()` | This field must be a valid UUID. |
| `integer()` | This field must be an integer. |
| `regex()` | This field format is invalid. |
| `in()` | This field must be one of the allowed values. |
| `confirmed()` | This field does not match its confirmation. |
| `before(date)` | This field must be before `<date>`, written in ISO format (for example `2030-01-01T00:00:00.000Z`). |
| `after(date)` | This field must be after `<date>`, in ISO format. |
| `beforeOrEqual(date)` | This field must be before or equal to `<date>`, in ISO format. |
| `afterOrEqual(date)` | This field must be after or equal to `<date>`, in ISO format. |
| `today()` | This field must be today. |
| `beforeToday()` | This field must be before today. |
| `afterToday()` | This field must be after today. |
| `todayOrBefore()` / `beforeOrToday()` | This field must be today or before. |
| `todayOrAfter()` / `afterOrToday()` | This field must be today or after. |
| `image()` | The selected file must be an image. |
| `imageAspectRatio(ratios)` | The selected image must have an allowed aspect ratio. |
| `custom()` returning `false` | Validation failed. |

## Custom messages

Pass a message as the last argument to any rule:

```ts
import { field, schema } from '@holo-js/validation'

export const registerUser = schema({
  email: field.string()
    .required('Email is required.')
    .email('Enter a valid email address.'),
  password: field.password()
    .required('Choose a password.')
    .min(8, 'Password must be at least 8 characters.'),
  birthday: field.date()
    .beforeToday('Your birthday must be in the past.'),
  avatar: field.file()
    .optional()
    .image('Upload a PNG, JPEG, or WebP image.')
    .maxSize('2mb', 'Images must be 2 MB or smaller.'),
})
```

`custom()` and `customAsync()` can also return the message directly:

```ts
field.string().custom(value => value !== 'admin' || 'That name is reserved.')
```

## Read errors

`safeParse()` returns an error bag in `result.errors`. A thrown `ValidationException` has the same bag on `error.errors`.

```ts
import { safeParse } from '@holo-js/validation'
import { checkout } from './schemas/checkout'

const result = await safeParse(input, checkout)

if (!result.valid) {
  result.errors.has('email')
  result.errors.first('email')
  result.errors.get('address.city')
  result.errors.flatten()
}
```

| Method | Returns |
|---|---|
| `has(path)` | `true` if the field has at least one error |
| `first(path)` | The first message, or `undefined` |
| `get(path)` | All messages for the field (an empty array if none) |
| `flatten()` | An object of `path → messages` |
| `toJSON()` | Same as `flatten()`, used by `JSON.stringify()` |

You can also read errors as typed properties that follow the schema shape:

```ts
result.errors.email
result.errors.address?.city
```

Errors that don't belong to one field, such as a rate-limit failure, use the path `_root`:

```ts
result.errors.first('_root')
```

## Add errors from your own logic

Some checks can only happen after validation, such as "this slug is already taken" or "the upload failed". Throw `ValidationException.withMessages()` to report them as field errors with the same 422 response:

```ts [app/api/posts/route.ts]
import { validate, ValidationException } from '@holo-js/validation'
import { createPost } from '@/server/schemas/post'
import Post from '@/server/models/Post'

export async function POST(request: Request) {
  const data = await validate(request, createPost)

  if (await Post.where('slug', data.slug).first()) {
    throw ValidationException.withMessages({
      slug: ['This slug is already in use.'],
    })
  }

  return Response.json(await Post.create(data), { status: 201 })
}
```

Use `isValidationException()` to narrow a live `ValidationException` and access its error bag methods. Framework HTTP errors and serialized payloads are not live exceptions.

At integration and transport boundaries, use `serializeValidationException(error)`. It returns a `SerializedValidationException` or `undefined`, recognizing live exceptions, framework wrappers, serialized payloads, and server error digests. Read field messages from `payload.errors`; the payload also retains `bag`, `values`, `status`, and retry metadata. Digest-only errors have empty values when the framework did not transmit them:

```ts
import { serializeValidationException } from '@holo-js/validation'

try {
  await savePost(formData)
} catch (error) {
  const payload = serializeValidationException(error)
  if (payload) {
    return payload
  }

  throw error
}
```

## Error bags

A page with two forms (for example, "update profile" and "change password") needs to know which form an error belongs to. Give each form its own bag name:

```ts
import { validate } from '@holo-js/validation'
import { changePassword } from './schemas/account'

const data = await validate(request, changePassword, { bag: 'password' })
```

```ts
import { ValidationException } from '@holo-js/validation'

throw ValidationException.withMessages({
  currentPassword: ['Your current password is incorrect.'],
}, {
  bag: 'password',
})
```

Read a named bag on the page with `useValidationErrors('password')` in Nuxt or SvelteKit. In SvelteKit, pass the page data as `useValidationErrors('password', { pageData: data })`. See [Framework Recipes](/basics/forms/frameworks).

## Exception reference

`validate()` throws a `ValidationException`. Its properties:

| Member | Description |
|---|---|
| `message` | The first error, prefixed with its field path (the same text as the `message` in the 422 response). |
| `status` | Always `422`, unless a [security check](/basics/forms/server#rate-limit-a-form) set another status such as `429`. |
| `bag` | The error bag name. `default` unless you passed `bag`. |
| `errors` | The [error bag](#error-bags) with `has()`, `get()`, `first()`, `flatten()`, and `toJSON()`. |
| `values` | The submitted values after type conversion. Uploaded files are left out. |
| `digest` | An encoded copy of the error payload. The Next.js adapter reads it to render errors. Don't parse it yourself. |
| `toJSON()` | The 422 response body as a plain object. |
| `ValidationException.withMessages(messages, options?)` | Create an exception from a `path → messages` object. `options.bag` names the bag. |

`ValidationContractError` is different: it means the schema itself is wrong. Holo throws it when you define or use a rule incorrectly, such as an empty `in()` list, a `regex()` that isn't a `RegExp`, or a `max()` string on a non-file field. It is not turned into a 422 response, so fix the code instead of catching it.

`createErrorBag(messages?)` builds the same error bag object from a `path → messages` object. Holo uses it internally, and you can use it when you need an error bag outside a validation run.

## Next steps

- [Available Rules](/basics/validation/rules)
- [Handling Submissions](/basics/forms/server)
- [Client-Side Forms](/basics/forms/client)
- [Error Responses](/basics/errors)
