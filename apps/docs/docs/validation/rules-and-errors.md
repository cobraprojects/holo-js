# Rules And Errors

Holo validation has two method layers:

- top-level validation methods like `validate(...)` and `parse(...)`
- fluent field methods like `required()`, `email()`, and `beforeOrToday()`

This page lists the currently available methods in `@holo-js/validation`.

## Custom messages

Built-in rules accept an optional custom message as the last argument.

```ts
import { field, schema, validate } from '@holo-js/validation'

const registerUser = schema({
  email: field.string()
    .required('Email is required.')
    .email('Enter a valid email address.'),
  password: field.string()
    .min(8, 'Password must be at least 8 characters.'),
  birthday: field.date()
    .beforeOrToday('Birthday cannot be in the future.'),
})

const result = await validate({
  email: 'bad',
  password: 'short',
  birthday: '2999-01-01',
}, registerUser)
```

`custom(...)` and `customAsync(...)` still support returning a string directly from the validator.

## Top-level methods

### `schema(shape)`

Creates a typed validation schema.

```ts
import { field, schema } from '@holo-js/validation'

const registerUser = schema({
  email: field.string().required().email(),
  password: field.string().required().min(8),
})
```

### `validate(input, schema)`

Validates input and returns a non-throwing result object.

Use this when you want `result.valid`, `result.data`, `result.values`, and `result.errors`.

```ts
import { field, schema, validate } from '@holo-js/validation'

const login = schema({
  email: field.string().required().email(),
})

const result = await validate({ email: 'bad' }, login)

if (!result.valid) {
  result.errors.first('email')
}
```

### `safeParse(input, schema)`

Alias-style non-throwing parsing for callers that prefer parse-oriented naming.

Use it the same way as `validate(...)` when you want a structured result instead of an exception.

```ts
import { field, schema, safeParse } from '@holo-js/validation'

const profile = schema({
  birthday: field.date().nullable(),
})

const result = await safeParse({ birthday: '2024-01-01' }, profile)
```

### `parse(input, schema)`

Validates input and throws on failure.

Use this when invalid input should stop execution immediately.

```ts
import { field, schema, parse } from '@holo-js/validation'

const createSession = schema({
  email: field.string().required().email(),
})

const data = await parse({ email: 'ava@example.com' }, createSession)
```

### `createErrorBag(flattenedErrors?)`

Creates a reusable error bag manually.

This is mostly useful for framework plumbing, tests, and custom integrations.

```ts
import { createErrorBag } from '@holo-js/validation'

const errors = createErrorBag({
  email: ['Email is invalid.'],
  'profile.city': ['City is required.'],
})

errors.first('email')
errors.flatten()
```

## Field factories

### `field.string()`

Creates a string field.

```ts
field.string().required().email()
```

### `field.number()`

Creates a number field with string-to-number coercion during validation.

```ts
field.number().integer().min(1)
```

### `field.boolean()`

Creates a boolean field with common web coercion.

```ts
field.boolean().default(false)
```

### `field.date()`

Creates a date field with string-to-`Date` coercion.

```ts
field.date().beforeOrToday()
```

### `field.file()`

Creates a file field for `File` or file-like web inputs.

```ts
field.file().required().image().maxSize('2mb')
```

### `field.array(itemField)`

Creates an array field from another field definition.

```ts
field.array(field.string().required()).min(1)
```

## Fluent field methods

### `required(message?)`

Marks the field as required.

```ts
field.string().required()
```

### `optional(message?)`

Allows `undefined`.

```ts
field.string().optional()
```

### `nullable(message?)`

Allows `null`.

```ts
field.date().nullable()
```

### `default(value, message?)`

Provides a default value when the input is missing.

```ts
field.boolean().default(false)
```

### `min(value, message?)`

Minimum length, size, or numeric lower bound depending on field type.

```ts
field.string().min(3)
field.number().min(18)
field.array(field.string()).min(1)
```

### `max(value, message?)`

Maximum length, size, numeric upper bound, or file size depending on field type and value.

```ts
field.string().max(255)
field.number().max(100)
field.file().max('2mb')
```

### `size(value, message?)`

Requires an exact length, count, or size.

```ts
field.array(field.string()).size(3)
```

### `email(message?)`

Validates email format.

```ts
field.string().email()
```

### `url(message?)`

Validates URL format.

```ts
field.string().url()
```

### `uuid(message?)`

Validates UUID format.

```ts
field.string().uuid()
```

### `integer(message?)`

Requires an integer number.

```ts
field.number().integer()
```

### `regex(pattern, message?)`

Matches a regular expression.

```ts
field.string().regex(/^[a-z0-9-]+$/)
```

### `in(values, message?)`

Restricts the value to a fixed list.

```ts
field.string().in(['draft', 'published', 'archived'] as const)
```

### `confirmed(message?)`

Requires a matching `...Confirmation` field, such as `password` and `passwordConfirmation`.

```ts
field.string().required().confirmed()
```

### `before(date, message?)`

Requires a date before another date.

```ts
field.date().before('2026-12-31')
```

### `after(date, message?)`

Requires a date after another date.

```ts
field.date().after(new Date())
```

### `beforeOrEqual(date, message?)`

Requires a date before or equal to another date.

```ts
field.date().beforeOrEqual('2026-12-31')
```

### `afterOrEqual(date, message?)`

Requires a date after or equal to another date.

```ts
field.date().afterOrEqual('2026-01-01')
```

### `today(message?)`

Requires the value to be today.

```ts
field.date().today()
```

### `beforeToday(message?)`

Requires a date before today.

```ts
field.date().beforeToday()
```

### `todayOrBefore(message?)`

Requires a date today or earlier.

```ts
field.date().todayOrBefore()
```

### `beforeOrToday(message?)`

Alias for today-or-before style validation.

```ts
field.date().beforeOrToday()
```

### `afterToday(message?)`

Requires a date after today.

```ts
field.date().afterToday()
```

### `todayOrAfter(message?)`

Requires a date today or later.

```ts
field.date().todayOrAfter()
```

### `afterOrToday(message?)`

Alias for today-or-after style validation.

```ts
field.date().afterOrToday()
```

### `transform(fn)`

Transforms the validated value.

```ts
field.string().transform(value => value.trim())
```

### `custom(fn, message?)`

Adds a synchronous custom validator. Return `true` for success or a string message for failure.

```ts
field.string().custom(value => value.startsWith('holo_') || 'Must start with holo_.')
```

### `customAsync(fn, message?)`

Adds an asynchronous custom validator. Return `true` for success or a string message for failure.

```ts
field.string().customAsync(async (value) => {
  return (await isUsernameAvailable(value)) || 'Username is already taken.'
})
```

### `image(message?)`

Requires an uploaded file to be an image.

```ts
field.file().image()
```

### `maxSize(value, message?)`

Sets a max upload size for files.

```ts
field.file().maxSize('2mb')
field.file().maxSize(1024)
```

## Error bag methods

On failure, `validate(...)` and `safeParse(...)` return a typed error bag.

### `errors.first(path)`

Returns the first message for a field path.

```ts
result.errors.first('email')
```

### `errors.get(path)`

Returns all messages for a field path.

```ts
result.errors.get('profile.city')
```

### `errors.has(path)`

Returns `true` when a path has errors.

```ts
result.errors.has('password')
```

### `errors.flatten()`

Returns a flat dot-path error object.

```ts
result.errors.flatten()
```

### `errors.toJSON()`

Returns a serializable error structure.

```ts
JSON.stringify(result.errors.toJSON())
```

### nested property access

Nested errors can also be accessed through typed properties.

```ts
result.errors.email
result.errors.profile?.city
```

## Values vs data

Use `result.data` on success.

```ts
if (result.valid) {
  result.data.email
}
```

Use `result.values` on failure.

```ts
if (!result.valid) {
  result.values.email
}
```

## Continue

- [Validation Overview](/validation/)
- [Forms Overview](/forms/)
