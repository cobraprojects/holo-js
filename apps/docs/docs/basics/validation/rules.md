# Available Rules

`@holo-js/validation` has seven field types. You chain rules on a field in any order; `transform()` and custom rules run in the order you write them. Every rule that checks a value takes an optional custom message as its last argument. See [Error Messages](/basics/validation/errors#custom-messages).

## Available rules

Rules are grouped by the field types they apply to. Rules marked "all fields" work on every type.

**Field types**

- [`field.string()`](#field-types), [`field.password()`](#field-types), [`field.number()`](#field-types), [`field.boolean()`](#field-types), [`field.date()`](#field-types), [`field.file()`](#field-types), [`field.array()`](#arrays)

**All fields**

<div class="method-list">

- [`required()`](#required-message)
- [`optional()`](#optional)
- [`nullable()`](#nullable)
- [`default()`](#default-value)
- [`sensitive()`](#sensitive)
- [`confirmed()`](#confirmed-message)
- [`transform()`](#transform-fn)
- [`custom()`](#custom-fn-message)
- [`customAsync()`](#customasync-fn-message)

</div>

**String fields**

- [`min()`](#min-value-message) and [`max()`](#max-value-message), counting characters
- [`size()`](#size-value-message), exact character count
- [`email()`](#email-message)
- [`url()`](#url-message)
- [`uuid()`](#uuid-message)
- [`regex()`](#regex-pattern-message)
- [`in()`](#in-values-message)

**Number fields**

- [`min()`](#min-value-message), [`max()`](#max-value-message), and [`size()`](#size-value-message), comparing the number itself
- [`integer()`](#integer-message)
- [`in()`](#in-values-message)

**Array fields**

- [`min()`](#min-value-message), [`max()`](#max-value-message), and [`size()`](#size-value-message), counting items

**Date fields**

- [`before()`](#before-date-message) and [`after()`](#after-date-message)
- [`beforeOrEqual()`](#beforeorequal-date-message) and [`afterOrEqual()`](#afterorequal-date-message)
- [`today()`](#today-message)
- [`beforeToday()`](#beforetoday-message) and [`afterToday()`](#aftertoday-message)
- [`todayOrBefore()`](#todayorbefore-message) and [`beforeOrToday()`](#beforeortoday-message)
- [`todayOrAfter()`](#todayorafter-message) and [`afterOrToday()`](#afterortoday-message)

**File fields**

- [`max()`](#max-value-message) and [`maxSize()`](#maxsize-value-message), limiting bytes
- [`size()`](#size-value-message), exact byte count
- [`image()`](#image-message)

## Field types

Each builder creates a field with a fixed output type. Chain rules after it.

| Builder | Output type | Accepts |
|---|---|---|
| `field.string()` | `string` | Strings |
| `field.password()` | `string` | Strings. Same as `string()` but marked [sensitive](#sensitive), and `min()` counts raw characters without trimming. |
| `field.number()` | `number` | Numbers, or numeric strings such as `'42'` |
| `field.boolean()` | `boolean` | Booleans, or `'1'`/`'true'`/`'on'`/`'yes'` and `'0'`/`'false'`/`'off'`/`'no'` |
| `field.date()` | `Date` | `Date` objects, or strings `new Date()` can parse |
| `field.file()` | `WebFileLike` (a `Blob` with an optional `name`) | Uploaded files from `FormData` |
| `field.array(item)` | `item[]` | Arrays. `item` is another field or an object shape. |

```ts
import { field, schema } from '@holo-js/validation'

export const updateProfile = schema({
  displayName: field.string().required().min(3).max(80),
  website: field.string().optional().url(),
  birthday: field.date().nullable().beforeToday(),
  avatar: field.file().optional().image().maxSize('2mb'),
})
```

### Arrays

Pass a field for a list of values, or an object for a list of records. Array rules such as `min()`, `max()`, and `size()` count items.

```ts
import { field, schema } from '@holo-js/validation'

export const gallery = schema({
  tags: field.array(field.string().required()).min(1).max(10),
  images: field.array({
    title: field.string().required(),
    caption: field.string().optional(),
  }),
})
```

Errors for items use their index, such as `tags.0` or `images.2.title`.

## Presence rules

### `required(message?)`

The value must be present. `undefined`, `null`, whitespace-only strings, and empty arrays fail with "This field is required."

```ts
field.string().required()
```

### `optional()`

Allows the value to be missing (`undefined`). The output type becomes `T | undefined`.

```ts
field.string().optional()
```

### `nullable()`

Allows `null`. The output type becomes `T | null`.

```ts
field.date().nullable()
```

A nullable array accepts `null` without checking its items. Rules on the item still apply to each item you send:

```ts
field.array(field.string().required().min(2)).optional().nullable()
```

This accepts `null`, a missing value, `[]`, or `['Valid']`, and rejects `[null]`, `['']`, and `['x']`.

### `default(value)`

Uses `value` when the input is missing. The field becomes optional, and the output type no longer includes `undefined`.

```ts
field.boolean().default(false)
field.array(field.number()).default([])
```

## Size rules

`min`, `max`, and `size` mean different things depending on the field type:

| Rule | `string` | `number` | `array` | `file` |
|---|---|---|---|---|
| `min(n)` | At least `n` characters | At least `n` | At least `n` items | Not supported |
| `max(n)` | At most `n` characters | At most `n` | At most `n` items | At most `n` bytes |
| `size(n)` | Exactly `n` characters | Exactly `n` | Exactly `n` items | Exactly `n` bytes |

### `min(value, message?)`

The minimum length for strings and arrays, or the minimum value for numbers. For `string()`, surrounding whitespace is ignored, so `'  a  '` has length 1. For `password()` and fields marked `sensitive()`, every character counts.

```ts
field.string().min(3)
field.number().min(1)
field.array(field.string()).min(1)
```

### `max(value, message?)`

The maximum length, value, or item count. On file fields, the value is bytes or a size string such as `'2mb'`. Size strings are only allowed on file fields.

```ts
field.string().max(255)
field.number().max(100)
field.file().max('2mb')
```

### `size(value, message?)`

The exact length, value, item count, or byte count. Use it for fixed-length codes.

```ts
field.string().size(6)
field.array(field.string()).size(3)
```

### `maxSize(value, message?)`

The maximum file size. Pass bytes as a number, or a string with `kb`, `mb`, or `gb` (1 kb = 1024 bytes). Decimal amounts such as `'1.5mb'` work. Any other format throws a `ValidationContractError` when you define the schema.

```ts
field.file().maxSize('2mb')
field.file().maxSize(500_000)
```

`max('2mb')` does the same thing on file fields.

## String rules

These apply to string fields.

### `email(message?)`

Must be a valid email address.

```ts
field.string().email()
```

### `url(message?)`

Must be a valid URL.

```ts
field.string().url()
```

### `uuid(message?)`

Must be a valid UUID.

```ts
field.string().uuid()
```

### `regex(pattern, message?)`

Must match a regular expression. Pass a `RegExp`, not a string. Passing anything else throws a `ValidationContractError`.

```ts
field.string().regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and dashes.')
```

## Number rules

### `integer(message?)`

Must be a whole number.

```ts
field.number().integer().min(1)
```

## Choice rules

### `in(values, message?)`

Must be one of the listed values. With `as const`, the output type narrows to those values. The list must not be empty.

```ts
field.string().in(['draft', 'published', 'archived'] as const)
field.number().in([10, 25, 50] as const)
```

### `confirmed(message?)`

Must equal a sibling field with the same name plus `Confirmation`. For example, `password` is compared with `passwordConfirmation`.

```ts
import { field, schema } from '@holo-js/validation'

export const changePassword = schema({
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})
```

Inside an array of objects, each item compares with its own confirmation field.

If `confirmed()` comes after a `transform()`, it compares the transformed value with the confirmation field's parsed output. Apply the same transform to both fields:

```ts
const passwords = schema({
  password: field.string().transform(value => value.trim()).confirmed(),
  passwordConfirmation: field.string().transform(value => value.trim()),
})
```

## Date rules

These apply to date fields. The comparison rules take another date as a `Date` or a date string. An invalid `Date` throws a `ValidationContractError`.

### `before(date, message?)`

The value must be earlier than `date`.

```ts
field.date().before('2030-01-01')
```

### `beforeOrEqual(date, message?)`

The value must be earlier than or equal to `date`.

```ts
field.date().beforeOrEqual(new Date('2026-12-31'))
```

### `after(date, message?)`

The value must be later than `date`.

```ts
field.date().after('2026-01-01')
```

### `afterOrEqual(date, message?)`

The value must be later than or equal to `date`.

```ts
field.date().afterOrEqual('2026-01-01')
```

### `today(message?)`

The value must be today (local time).

```ts
field.date().today()
```

### `beforeToday(message?)`

The value must be before the start of today.

```ts
field.date().beforeToday('Your birthday must be in the past.')
```

### `afterToday(message?)`

The value must be after the end of today.

```ts
field.date().afterToday()
```

### `todayOrBefore(message?)`

The value must be today or earlier. `beforeOrToday()` is the same rule with a different name.

```ts
field.date().todayOrBefore()
```

### `beforeOrToday(message?)`

Same as `todayOrBefore()`. Use whichever name reads better.

```ts
field.date().beforeOrToday()
```

### `todayOrAfter(message?)`

The value must be today or later. `afterOrToday()` is the same rule with a different name.

```ts
field.date().todayOrAfter()
```

### `afterOrToday(message?)`

Same as `todayOrAfter()`. Use whichever name reads better.

```ts
field.date().afterOrToday()
```

## File rules

### `image(message?)`

The uploaded file must be a complete, readable JPEG, PNG, GIF, WebP, AVIF, or TIFF image.

```ts
field.file().required().image().maxSize('5mb')
```

Holo checks the file's contents, not its name or the type the browser reports. A script renamed to `avatar.png` fails. SVG files fail too, because they can contain scripts. If you need SVG uploads, accept them in a [media collection](/media/) with `acceptsMimeTypes(['image/svg+xml'])` and never show them inline.

On the server, Holo also decodes the whole image, including every frame of an animated GIF or WebP. A damaged or cut-off file fails, and so does an image larger than 40 million pixels in total or with more than 1,000 frames. This needs the `sharp` package in your app:

```bash
npm install sharp
```

Without it, server-side validation fails with an error asking you to install it. In the browser, `image()` checks the file's contents quickly and leaves the full decode to the server.

## Sensitive data

### `sensitive()`

Marks a field as sensitive. Form failure payloads from `submission.fail()` and `submission.serialize()` leave sensitive values out, and `useForm()` clears them after a failed submission. Password fields (`field.password()`), file fields, and fields named `password`, `passwordConfirmation`, `password_confirmation`, `currentPassword`, `current_password`, `newPassword`, `new_password`, `confirmPassword`, or `confirm_password` are already treated as sensitive.

```ts
field.string().sensitive().optional()
```

## Custom logic

### `transform(fn)`

Changes the value. The return value is passed to the next rules and becomes the output type.

```ts
field.string()
  .transform(value => value.trim())
  .custom(value => value.startsWith('holo_') || 'Must start with holo_.')
```

Rules only see the value at their position in the chain. Here `custom()` receives the trimmed string; put it before `transform()` to check the raw string.

If a custom rule before a transform fails, that transform and every rule after it are skipped. Rules before it can still add errors.

Array items are validated before a transform on the array itself. If an item fails, the array transform doesn't run, so you can't filter out bad items with it:

```ts
const post = schema({
  tags: field.array(
    field.string().custom(value => value !== 'blocked' || 'This tag is blocked.'),
  ).transform(values => values.filter(value => value !== 'blocked')),
})
```

Submitting `['blocked', 'allowed']` fails with an error on `tags.0`. To skip items entirely, filter the input before you validate it.

### `custom(fn, message?)`

Adds your own synchronous check. Return `true` to pass, `false` to fail with the default or supplied message, or a string to fail with that string.

```ts
field.string().custom(value => !value.includes(' ') || 'Spaces are not allowed.')
```

### `customAsync(fn, message?)`

Same as `custom()`, but the function can be async. Holo runs async checks one at a time, in field order.

```ts
import { field } from '@holo-js/validation'
import User from '@/server/models/User'

field.string().required().email().customAsync(async (email) => {
  const existing = await User.where('email', email).first()
  return !existing || 'This email is already registered.'
})
```

Custom rules only run when the value is present and has the right type.

## Next steps

- [Error Messages](/basics/validation/errors)
- [Validation](/basics/validation/)
- [Forms](/basics/forms/)
