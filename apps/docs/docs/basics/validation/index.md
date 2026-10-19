# Validation

`@holo-js/validation` checks incoming data against a schema and gives you back typed, cleaned-up values. Use it for JSON APIs, query strings, uploads, CLI input, or anywhere else you need to trust data before using it.

If you are handling an HTML form, also read [Forms](/basics/forms/). Forms are built on top of validation.

## Quick example

```ts [server/schemas/post.ts]
import { field, schema } from '@holo-js/validation'

export const createPost = schema({
  title: field.string().required().min(3).max(255),
  body: field.string().required(),
  status: field.string().required().in(['draft', 'published'] as const),
  publishAt: field.date().optional().afterOrToday(),
})
```

```ts
import { validate } from '@holo-js/validation'
import { createPost } from './schemas/post'

const data = await validate({
  title: 'Hello Holo',
  body: 'First post.',
  status: 'draft',
}, createPost)

data.title
data.status
```

`data` is fully typed: `data.status` is `'draft' | 'published'`, and `data.publishAt` is `Date | undefined`. If the input is invalid, `validate()` throws a `ValidationException` and Holo turns it into a [422 response](/basics/validation/errors).

## Install

Pick `validation` (or `forms`, which includes it) when you create the project. To add it later, install `@holo-js/validation` with your package manager.

## Define a schema

A schema is an object of fields. Each field starts with a type and chains rules:

```ts
import { field, schema } from '@holo-js/validation'

export const registerUser = schema({
  name: field.string().required().max(80),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
  age: field.number().integer().min(13).optional(),
  newsletter: field.boolean().default(false),
  avatar: field.file().optional().image().maxSize('2mb'),
  tags: field.array(field.string()).max(5).default([]),
})
```

The available types are `string`, `password`, `number`, `boolean`, `date`, `file`, and `array`. See [Available Rules](/basics/validation/rules) for every rule.

`schema()` and `defineSchema()` are the same function. Use either name.

### Nested objects

Nest plain objects to validate nested data. Error paths use dots, such as `address.city`.

```ts
const checkout = schema({
  email: field.string().required().email(),
  address: {
    street: field.string().required(),
    city: field.string().required(),
    postcode: field.string().required().max(10),
  },
})
```

### Required, optional, and nullable

Every field must be present and of the right type unless you say otherwise:

| You write | Accepts `undefined` | Accepts `null` | Rejects empty strings and `[]` |
|---|---|---|---|
| `field.string()` | No | No | No |
| `field.string().required()` | No | No | Yes |
| `field.string().optional()` | Yes | No | No |
| `field.string().nullable()` | No | Yes | No |
| `field.string().optional().nullable()` | Yes | Yes | No |
| `field.boolean().default(false)` | Yes, becomes `false` | No | No |

Use `required()` on strings when a whitespace-only value should fail with "This field is required."

## Validate different inputs

`validate()`, `safeParse()`, and `parse()` accept a web `Request`, `FormData`, `URLSearchParams`, or a plain object.

```ts [app/api/posts/route.ts]
import { validate } from '@holo-js/validation'
import { createPost } from '@/server/schemas/post'
import Post from '@/server/models/Post'

export async function POST(request: Request) {
  const data = await validate(request, createPost)
  const post = await Post.create(data)

  return Response.json(post, { status: 201 })
}
```

When you pass a `Request`, Holo reads it based on the method and content type:

| Request | Data read from |
|---|---|
| `GET` or `HEAD` | Query string |
| `application/json` | JSON body |
| `multipart/form-data` or `application/x-www-form-urlencoded` | Form body |
| Empty body | Treated as `{}` |

A JSON body that can't be parsed is treated as `{}`, so required fields fail with their usual messages. Any other content type throws an error.

Form fields can use dot or bracket names for nested data: `address.city`, `address[city]`, `tags[]`, and `tags[0]` all work. A repeated name such as `tags=a&tags=b` becomes an array.

### Input limits

Holo limits form bodies and query strings, so a small request can't make validation do a lot of work:

- A request can send at most 1,000 fields, the same default as PHP's `max_input_vars`.
- A list index must be lower than the number of values sent for that list. `tags[1]` with `tags[0]` works, but `tags[5]` on its own fails.
- Names that use `__proto__`, `constructor`, or `prototype` fail. So does a name that treats a list as an object, such as sending both `tags[0]` and `tags[name]`.

These requests don't throw. They fail validation with one of these errors on `_root`, so `validate()` responds with a [422](/basics/validation/errors#the-422-response):

| Problem | Message |
|---|---|
| More than 1,000 fields | The request contains too many input variables. |
| List index too high | The request contains an invalid list index. |
| Blocked or mixed name | The request contains an invalid field name. |

JSON bodies and plain objects are not counted toward the field limit. Use `max()` on array fields to limit lists in JSON.

### Automatic type conversion

Form data and query strings only contain strings, so Holo converts values before checking rules:

- `field.number()` turns `'42'` into `42`.
- `field.boolean()` turns `'1'`, `'true'`, `'on'`, and `'yes'` into `true`, and `'0'`, `'false'`, `'off'`, and `'no'` into `false`.
- `field.date()` turns any string `new Date()` can parse into a `Date`.
- An empty string becomes `undefined` for every type except strings, so an empty optional number input is simply omitted.
- An empty file input (zero bytes, no name) becomes `undefined`.
- A single value for an `array` field becomes a one-item array.

## Choose how failures are reported

| Function | On success | On failure |
|---|---|---|
| `validate(input, schema)` | Returns typed data | Throws `ValidationException` (status 422) |
| `safeParse(input, schema)` | `{ valid: true, data }` | `{ valid: false, values, errors }` |
| `parse(input, schema)` | Returns typed data | Throws `ValidationContractError` |

Use `validate()` in route handlers. Holo catches the exception and sends a 422 response, so you only write the happy path.

Use `safeParse()` when you want to handle errors yourself:

```ts
import { safeParse } from '@holo-js/validation'
import { createPost } from './schemas/post'

const result = await safeParse(input, createPost)

if (!result.valid) {
  console.log(result.errors.first('title'))
  console.log(result.values.title)
} else {
  console.log(result.data.title)
}
```

On failure, `result.values` holds the converted input so you can show it again. On success, `result.data` holds the validated output.

Use `parse()` for internal data where a bad value is a programming error, not a user mistake. Its error is not turned into a 422 response.

Pass `{ bag }` as the third argument to `validate()` to name the error bag. See [Error bags](/basics/validation/errors#error-bags).

## Transform and custom rules

Use `transform()` to change a value and `custom()` or `customAsync()` for your own checks. Each step receives the output of the step before it.

```ts
import { field, schema } from '@holo-js/validation'
import User from '@/server/models/User'

export const signup = schema({
  username: field.string()
    .required()
    .transform(value => value.trim().toLowerCase())
    .regex(/^[a-z0-9_]+$/, 'Use letters, numbers, and underscores.')
    .customAsync(async (value) => {
      const existing = await User.where('username', value).first()
      return !existing || 'That username is taken.'
    }),
})
```

A custom validator returns `true` to pass, `false` to fail with the default message (or the message you pass as the second argument), or a string to fail with that string. See [transform](/basics/validation/rules#transform-fn) for ordering details.

## Use schemas with other libraries

Every schema and every field implements [Standard Schema](https://standardschema.dev). You can pass them to any tool that accepts Standard Schema, such as SvelteKit remote functions, tRPC, or TanStack Form, without a wrapper.

```ts [src/routes/posts/posts.remote.ts]
import { query } from '$app/server'
import { field } from '@holo-js/validation'
import Post from '../../../server/models/Post'

export const getPost = query(field.string().required(), async (slug) => {
  return await Post.where('slug', slug).firstOrFail()
})
```

## Reference

### Functions

| Function | What it does |
|---|---|
| `field.string()`, `field.password()`, `field.number()`, `field.boolean()`, `field.date()`, `field.file()` | Start a field of that type. See [field types](/basics/validation/rules#field-types). |
| `field.array(item)` | Start a list field. `item` is a field or an object shape. Same as `arrayField(item)`. |
| `schema(shape)` / `defineSchema(shape)` | Build a schema from an object of fields. The two names are the same function. |
| `validate(input, schema, options?)` | Return typed data, or throw a `ValidationException`. `options.bag` names the error bag. |
| `safeParse(input, schema)` | Return `{ valid, values, errors }` or `{ valid, data, values, errors }` without throwing. |
| `parse(input, schema)` | Return typed data, or throw a `ValidationContractError`. Use it for internal data. |
| `isValidationSchema(value)` | Return `true` if `value` is a schema built by `schema()`. |
| `isValidationException(value)` | Narrow a live `ValidationException` with error bag methods. See [Error Messages](/basics/validation/errors#add-errors-from-your-own-logic). |
| `serializeValidationException(value)` | Read a serialized failure payload from live exceptions, framework wrappers, serialized payloads, or digests. Returns `undefined` for unrelated errors. |
| `createErrorBag(messages?)` | Build an error bag from a `path → messages` object. See [Read errors](/basics/validation/errors#read-errors). |

`ValidationException` is the error that `validate()` throws. `ValidationContractError` is thrown when a schema is defined or used incorrectly. See [Error Messages](/basics/validation/errors#exception-reference).

### Field builder methods

Every method below returns a new builder, so you can chain them in any order. Each one is explained on [Available Rules](/basics/validation/rules).

| Group | Methods |
|---|---|
| Presence | [`required`](/basics/validation/rules#required-message), [`optional`](/basics/validation/rules#optional), [`nullable`](/basics/validation/rules#nullable), [`default`](/basics/validation/rules#default-value), [`sensitive`](/basics/validation/rules#sensitive) |
| Size | [`min`](/basics/validation/rules#min-value-message), [`max`](/basics/validation/rules#max-value-message), [`size`](/basics/validation/rules#size-value-message), [`maxSize`](/basics/validation/rules#maxsize-value-message) |
| Format and choice | [`email`](/basics/validation/rules#email-message), [`url`](/basics/validation/rules#url-message), [`uuid`](/basics/validation/rules#uuid-message), [`integer`](/basics/validation/rules#integer-message), [`regex`](/basics/validation/rules#regex-pattern-message), [`in`](/basics/validation/rules#in-values-message), [`confirmed`](/basics/validation/rules#confirmed-message) |
| Dates | [`before`](/basics/validation/rules#before-date-message), [`after`](/basics/validation/rules#after-date-message), [`beforeOrEqual`](/basics/validation/rules#beforeorequal-date-message), [`afterOrEqual`](/basics/validation/rules#afterorequal-date-message), [`today`](/basics/validation/rules#today-message), [`beforeToday`](/basics/validation/rules#beforetoday-message), [`todayOrBefore`](/basics/validation/rules#todayorbefore-message), [`beforeOrToday`](/basics/validation/rules#beforeortoday-message), [`afterToday`](/basics/validation/rules#aftertoday-message), [`todayOrAfter`](/basics/validation/rules#todayorafter-message), [`afterOrToday`](/basics/validation/rules#afterortoday-message) |
| Files | [`image`](/basics/validation/rules#image-message) |
| Your own logic | [`transform`](/basics/validation/rules#transform-fn), [`custom`](/basics/validation/rules#custom-fn-message), [`customAsync`](/basics/validation/rules#customasync-fn-message) |

Every builder also implements [Standard Schema](https://standardschema.dev) through its `~standard` property.

## Next steps

- [Available Rules](/basics/validation/rules)
- [Error Messages](/basics/validation/errors)
- [Forms](/basics/forms/)
- [Routing and Requests](/basics/routing)
