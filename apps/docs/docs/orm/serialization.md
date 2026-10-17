# Serialization

Serialization turns a model into a plain object you can send as JSON. You decide which attributes are hidden, which computed values are added, and how dates are formatted.

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password'],
  hidden: ['password', 'remember_token'],
})
```

```ts
const user = await User.findOrFail(1)

user.toJSON()
// { id: 1, name: 'Amina', email: 'amina@example.com', created_at: Date, updated_at: Date }
```

## Converting models to JSON

Call `toJSON()` on a model or a collection:

```ts
const post = await Post.findOrFail(1)
const data = post.toJSON()

const posts = await Post.where('status', 'published').get()
const list = posts.toJSON()
```

`JSON.stringify()` calls `toJSON()` for you, so returning a model from an API route sends its serialized form.

The result is typed from your table's columns, so `data.title` autocompletes.

### Querying straight to JSON

Every query method that returns models has a `Json` version that returns plain objects instead:

```ts
const posts = await Post.where('status', 'published').latest().getJson()
const post = await Post.with('author').findOrFailJson(1)
const first = await Post.firstJson()
const page = await Post.paginateJson(20, 1)
```

| Method | Returns |
| --- | --- |
| `getJson()` | An array of plain objects |
| `firstJson()` | One object, or `undefined` |
| `findOrFailJson(id)` | One object, or throws if not found |
| `soleJson()` | Exactly one object, or throws |
| `paginateJson()` | `{ data, meta }` |
| `simplePaginateJson()` | `{ data, meta }` |
| `cursorPaginateJson()` | `{ data, perPage, cursorName, nextCursor, prevCursor }` |

These are handy when the data crosses a boundary that only accepts plain objects, such as props passed from a Next.js server component to a client component, or a SvelteKit `load` function.

### Serializing mixed values

`serializeModels()` walks any value and calls `toJSON()` on every model it finds. Use it when you return an object that holds several models:

```ts
import { serializeModels } from '@holo-js/db'

const author = await User.findOrFail(1)
const posts = await Post.where('user_id', 1).get()

return serializeModels({ author, posts, total: posts.length })
```

The return type mirrors the input with each model replaced by its JSON shape. `Date` values are kept as `Date`.

## Hiding attributes

List attributes in `hidden` to leave them out of JSON. Use this for passwords, tokens, and internal flags:

```ts
export default defineModel('users', {
  hidden: ['password', 'remember_token'],
})
```

Hidden attributes are still on the model. `user.password` works in your server code.

### Allow-listing attributes

Use `visible` to include only the listed attributes:

```ts
export default defineModel('users', {
  visible: ['id', 'name', 'avatar_url'],
})
```

When `visible` is set, anything not listed is left out, including loaded relations.

### Changing visibility for one response

Adjust visibility on a single model or a whole collection. Each method returns the model or collection, so you can chain `toJSON()`:

```ts
user.makeVisible('email').toJSON()

user.makeHidden('email', 'created_at').toJSON()

user.setVisible(['id', 'name']).toJSON()

user.setHidden(['password']).toJSON()

const users = await User.all()
users.makeHidden('email').toJSON()
```

| Method | Effect |
| --- | --- |
| `makeVisible(...keys)` | Shows keys that would otherwise be hidden |
| `makeHidden(...keys)` | Hides more keys |
| `setVisible(keys)` | Shows only these keys |
| `setHidden(keys)` | Replaces the hidden list |

These changes only affect that model instance. The model definition stays the same.

## Appending computed values

An [accessor](/orm/casts#computed-attributes) can define an attribute with no column. Add its name to `appended` to include it in JSON:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  accessors: {
    display_name: (_value, user) => {
      const { first_name, last_name } = user.toAttributes()
      return `${String(first_name)} ${String(last_name)}`.trim()
    },
  },
  appended: ['display_name'],
})
```

Change appended values for one response:

```ts
user.append('display_name').toJSON()

user.setAppends(['display_name']).toJSON()

user.withoutAppends().toJSON()
```

Hidden and visible rules apply to appended values too.

## Relations in JSON

Relations you've loaded are included under their relation name, and their own `hidden` rules apply. Relations you haven't loaded are left out.

```ts
const post = await Post.with('author', 'comments').findOrFail(1)

post.toJSON()
// { id: 1, title: 'Hello', author: { id: 3, name: 'Amina' }, comments: [ ... ] }
```

The return type of `toJSON()` includes the relations you loaded with `with()`, so their fields autocomplete too. Hide a relation by adding its name to `hidden` or calling `makeHidden('author')`.

Aggregates loaded with `withCount()` and similar methods appear as attributes such as `comments_count`. See [eager loading and aggregates](/orm/relationships/loading).

## Date formatting

By default, `toJSON()` keeps dates as `Date` objects, and `JSON.stringify()` writes them as ISO 8601 strings.

Set `serializeDate` to format every date on a model:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  serializeDate: date => date.toISOString().slice(0, 10),
})
```

```ts
post.toJSON()
// { published_at: '2025-06-07', ... }
```

A [date cast with a format](/orm/casts#date-formats-in-json-output) such as `'datetime:Y-m-d H:i'` takes priority for that column.

## Available methods

Each method is described in the [method reference](#method-reference) below. Collection versions of the visibility and append methods are on the [collections page](/orm/collections#available-methods).

**Convert to plain data:** [toJSON()](#tojson), [toAttributes()](#toattributes), [serializeModels()](#serializemodels)

**Hide and show:** [makeHidden()](#makehidden), [makeVisible()](#makevisible), [setHidden()](#sethidden), [setVisible()](#setvisible)

**Append computed values:** [append()](#append), [setAppends()](#setappends), [withoutAppends()](#withoutappends)

## Method reference

### toJSON()

Returns the model as a plain object, with hidden attributes removed, visible-only rules applied, and appended values added. Loaded relations are included.

```ts
return user.toJSON()
```

### toAttributes()

Returns a copy of the stored attributes, without any hidden, visible, or appended rules. Use it when you need every column, such as to pass data to another write.

```ts
const attributes = user.toAttributes()
```

### serializeModels()

Walks any value, such as an object or an array, and calls `toJSON()` on every model it finds. Dates pass through unchanged.

```ts
return serializeModels({ author, posts, total: posts.length })
```

### makeHidden()

Hides the given attributes on this instance, in addition to the model's `hidden` list. Use `makeVisible()` to show a key again.

```ts
user.makeHidden('email').toJSON()
```

### makeVisible()

Shows the given attributes on this instance, even when the model hides them.

```ts
user.makeVisible('remember_token').toJSON()
```

### setHidden()

Replaces the hidden list for this instance. Only the keys you pass are hidden.

```ts
user.setHidden(['password']).toJSON()
```

### setVisible()

Limits the output of this instance to the keys you pass.

```ts
user.setVisible(['id', 'name']).toJSON()
```

### append()

Adds computed attributes to this instance's JSON. See [appending computed values](#appending-computed-values).

```ts
user.append('display_name').toJSON()
```

### setAppends()

Replaces the appended attributes for this instance with the list you pass.

```ts
user.setAppends(['display_name']).toJSON()
```

### withoutAppends()

Removes every appended attribute from this instance's JSON, including the model's `appended` list.

```ts
user.withoutAppends().toJSON()
```

## Next steps

- [Casts and mutators](/orm/casts)
- [Collections](/orm/collections)
- [Eager loading and aggregates](/orm/relationships/loading)
- [Pagination](/database/pagination)
