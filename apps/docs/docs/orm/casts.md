# Casts and Mutators

Casts convert a column's value when Holo reads it from the database and when it writes it back. Accessors and mutators let you change a value on read or on write with your own function. Use them to turn stored strings into dates, encrypt a column, or tidy input before it's saved.

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'last_login_at'],
  casts: {
    last_login_at: 'datetime',
  },
  mutators: {
    email: value => String(value).trim().toLowerCase(),
  },
})
```

```ts
const user = await User.create({ name: 'Amina', email: '  Amina@Example.com ' })

user.email
// 'amina@example.com'
```

## How casts and types fit together

Holo infers each attribute's TypeScript type from the column in your [migration](/database/migrations). A `table.boolean('is_featured')` column is a `boolean`, a `table.timestamp('published_at').nullable()` column is `Date | null`, and `table.enum('status', ['draft', 'published'])` is `'draft' | 'published'`.

Casts change the value at runtime. They do not change the inferred type.

::: warning
Pick the column type that matches the value you want, and use casts for conversions the column type can't express. If a cast returns something different from the column type (for example a `Money` object from an integer column), TypeScript still sees the column type.
:::

## Built-in casts

Set a cast by column name in the `casts` option:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  casts: {
    is_featured: 'boolean',
    view_count: 'number',
    reference: 'string',
    metadata: 'json',
    published_at: 'datetime',
  },
})
```

| Cast | Read from database | Write to database |
| --- | --- | --- |
| `'boolean'` | `Boolean(value)` | `Boolean(value)` |
| `'number'` | `Number(value)` | `Number(value)` |
| `'string'` | `String(value)` | `String(value)` |
| `'json'` | Parses a JSON string | Serializes to a JSON string |
| `'date'`, `'datetime'`, `'timestamp'` | A `Date` object | An ISO 8601 string |
| `'vector'` | An array of numbers | A `[1,2,3]` string |

`null` and `undefined` pass through every built-in cast unchanged.

### JSON columns

Columns created with `table.json()` are already encoded on write and decoded on read. You don't need a `'json'` cast for them. Use `'json'` when JSON is stored in a plain text column.

```ts
const post = await Post.create({ title: 'Hello', settings: { theme: 'dark' } })

post.settings
// { theme: 'dark' }
```

Holo keeps SQL `NULL` and JSON `null` apart. Setting `settings` to `null` stores SQL `NULL`.

To filter on keys inside a JSON column, see `whereJson()` in [querying models](/orm/querying).

### Date formats in JSON output

Add a format after a colon to control how a date appears in `toJSON()`. The attribute is still a `Date` in your code.

```ts [server/models/Event.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('events', {
  casts: {
    starts_at: 'datetime:Y-m-d H:i:s',
    sent_at: 'timestamp:unix',
  },
})
```

```ts
event.starts_at
// Date 2025-06-07T08:09:10.000Z

event.toJSON()
// { starts_at: '2025-06-07 08:09:10', sent_at: 1749283751, ... }
```

Format tokens are `Y` (year), `m` (month), `d` (day), `H` (hours), `i` (minutes), and `s` (seconds), all in UTC. `unix` outputs seconds since the epoch.

To change how every date on a model is serialized, see [serialization](/orm/serialization#date-formatting).

### Vector dimensions

Add the expected number of dimensions to `'vector'` and Holo rejects arrays of any other length:

```ts
casts: {
  embedding: 'vector:1536',
}
```

## Enum casts

`enumCast()` makes sure a column only holds values from a TypeScript enum. Holo throws if you try to save an unknown value, or if one is read from the database.

```ts [server/models/Order.ts]
import { defineModel, enumCast } from '@holo-js/db'

export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
  Shipped = 'shipped',
}

export default defineModel('orders', {
  fillable: ['status'],
  casts: {
    status: enumCast(OrderStatus),
  },
})
```

```ts
await Order.create({ status: OrderStatus.Paid })
await Order.create({ status: 'refunded' })
// throws: Enum cast rejected unsupported value "refunded".
```

::: tip
If you only need a fixed set of strings, define the column with `table.enum('status', ['pending', 'paid', 'shipped'])`. The model attribute is then typed as that union.
:::

## Encrypted casts

`encryptedCast()` encrypts a value before it's saved and decrypts it when read. It uses AES-256-GCM with a key derived from the secret you pass.

```ts [server/models/Integration.ts]
import { defineModel, encryptedCast } from '@holo-js/db'

const encryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
if (!encryptionKey) {
  throw new Error('INTEGRATION_ENCRYPTION_KEY is not set.')
}

export default defineModel('integrations', {
  fillable: ['name', 'api_token'],
  casts: {
    api_token: encryptedCast(encryptionKey),
  },
})
```

The column stores a string that starts with `enc:`. Strings come back as strings; objects and arrays come back as the same JSON value.

Every write uses a random IV, so the same plain text produces different stored values. You can't search or filter on an encrypted column. If you change the secret, existing values can no longer be read.

## Binary casts

`binaryCast()` returns a `Uint8Array` for blob columns. Strings read from the database are decoded from base64.

```ts [server/models/Attachment.ts]
import { binaryCast, defineModel } from '@holo-js/db'

export default defineModel('attachments', {
  fillable: ['name', 'payload'],
  casts: {
    payload: binaryCast(),
  },
})
```

## Custom casts

A custom cast is any object with a `get` function (read), a `set` function (write), or both.

```ts [server/models/Product.ts]
import { defineModel } from '@holo-js/db'

export class Money {
  constructor(readonly cents: number) {}
}

class MoneyCast {
  get(value: unknown) {
    return value == null ? value : new Money(Number(value))
  }

  set(value: unknown) {
    return value instanceof Money ? value.cents : Number(value)
  }
}

export default defineModel('products', {
  fillable: ['name', 'price'],
  casts: {
    price: new MoneyCast(),
  },
})
```

Holo compares the stored form of a cast value when checking if a model changed. Setting `price` to an equal `Money` doesn't mark the model dirty.

A cast with only `set` transforms values on the way in and returns the stored value as-is on the way out:

```ts
casts: {
  sku: { set: value => String(value).toUpperCase() },
}
```

If `set` throws, the write is cancelled and nothing is saved.

### Castable objects

An object with a `castUsing()` method can return the cast to use. This lets a class decide its own storage format:

```ts [server/models/Order.ts]
import { defineModel } from '@holo-js/db'

class Address {
  castUsing() {
    return {
      get: (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value,
      set: (value: unknown) => JSON.stringify(value),
    }
  }
}

export default defineModel('orders', {
  casts: {
    shipping_address: new Address(),
  },
})
```

## Casting at query time

Use `withCasts()` to apply casts for a single query without changing the model:

```ts
const users = await User.query()
  .withCasts({ last_posted_at: 'date' })
  .get()
```

This is useful when a query selects a computed value, such as a subquery, that you want converted.

## Mutators

A mutator runs on every write to an attribute, before casts. Use it to normalize input:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email'],
  mutators: {
    name: value => String(value).trim(),
    email: value => String(value).trim().toLowerCase(),
  },
})
```

Mutators run on `create()`, `save()`, `update()`, and query builder `update()` calls made through the model. Each write runs a mutator once, including a `make()` followed by `save()`, and factory-made records.

## Accessors

An accessor runs every time an attribute is read. It receives the stored value and the model:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  accessors: {
    name: value => String(value).toUpperCase(),
  },
})
```

```ts
user.name
// 'AMINA'
```

The database still holds the original value.

### Computed attributes

An accessor can define an attribute that has no column. Read other attributes from the model with `toAttributes()`, and list the name in `appended` so it shows up in JSON:

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

```ts
user.toJSON()
// { id: 1, first_name: 'Amina', last_name: 'Haddad', display_name: 'Amina Haddad', ... }
```

See [serialization](/orm/serialization#appending-computed-values) for adding appended attributes per response.

## Next steps

- [Serialization](/orm/serialization)
- [Creating and updating models](/orm/writes)
- [Migrations](/database/migrations)
- [Defining models](/orm/)
