# Querying Models

Every model is a query builder for its table. You chain filters and finish with a method like `get()` or `first()`. Column names autocomplete, and results come back as typed model instances.

```ts [server/lib/posts.ts]
import Post from '../models/Post'

export async function getPublishedPosts() {
  return await Post
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .get()
}
```

## Available methods

Model-specific methods are described in the [method reference](#method-reference) below. Shared methods link to the query builder pages, which document them for both models and tables.

**Start a query:** [query()](#query), [newQuery()](#newquery), [newModelQuery()](#newmodelquery), [newQueryWithoutScopes()](#newquerywithoutscopes), [newQueryWithoutRelationships()](#newquerywithoutrelationships), [from()](/database/query-builder/selects-and-filters)

**Retrieve models:** [all()](#all), [get()](#get), [first()](#first), [firstOrFail()](#firstorfail), [find()](#find), [findMany()](#findmany), [findOrFail()](#findorfail), [firstWhere()](#firstwhere), [findOr()](#findor), [firstOr()](#firstor), [findOrNew()](#findornew), [whereKey()](#wherekey), [whereKeyNot()](#wherekeynot), [sole()](#sole), [hydrate()](#hydrate)

**Retrieve plain JSON:** [getJson()](#getjson), [firstJson()](#firstjson), [findOrFailJson()](#findorfailjson), [soleJson()](#solejson)

**Values and aggregates:** [value()](/database/query-builder/#value), [valueOrFail()](/database/query-builder/#value), [soleValue()](/database/query-builder/#value), [pluck()](/database/query-builder/#value), [implode()](/database/query-builder/#implode), [count()](/database/query-builder/#value), [exists()](/database/query-builder/#value), [doesntExist()](/database/query-builder/#value), [existsOr()](/database/query-builder/#existsor), [doesntExistOr()](/database/query-builder/#doesntexistor), [sum()](/database/query-builder/#value), [avg()](/database/query-builder/#value), [average()](/database/query-builder/#average), [min()](/database/query-builder/#value), [max()](/database/query-builder/#value)

**Filter rows:** [where()](/database/query-builder/selects-and-filters#where), [orWhere()](/database/query-builder/selects-and-filters#orwhere), [whereNot()](/database/query-builder/selects-and-filters#wherenot), [orWhereNot()](/database/query-builder/selects-and-filters#orwherenot), [whereNull()](/database/query-builder/selects-and-filters#wherenull), [whereNotNull()](/database/query-builder/selects-and-filters#wherenotnull), [whereIn()](/database/query-builder/selects-and-filters#wherein), [whereNotIn()](/database/query-builder/selects-and-filters#wherenotin), [whereBetween()](/database/query-builder/selects-and-filters#wherebetween), [whereNotBetween()](/database/query-builder/selects-and-filters#wherenotbetween), [orWhereIn()](/database/query-builder/selects-and-filters#orwherein), [orWhereNotIn()](/database/query-builder/selects-and-filters#orwherenotin), [orWhereBetween()](/database/query-builder/selects-and-filters#orwherebetween), [orWhereNotBetween()](/database/query-builder/selects-and-filters#orwherenotbetween), [whereBetweenColumns()](/database/query-builder/selects-and-filters#wherebetweencolumns), [orWhereBetweenColumns()](/database/query-builder/selects-and-filters#orwherebetweencolumns), [whereNotBetweenColumns()](/database/query-builder/selects-and-filters#wherenotbetweencolumns), [orWhereNotBetweenColumns()](/database/query-builder/selects-and-filters#orwherenotbetweencolumns), [whereValueBetween()](/database/query-builder/selects-and-filters#wherevaluebetween), [orWhereValueBetween()](/database/query-builder/selects-and-filters#orwherevaluebetween), [whereValueNotBetween()](/database/query-builder/selects-and-filters#wherevaluenotbetween), [orWhereValueNotBetween()](/database/query-builder/selects-and-filters#orwherevaluenotbetween), [whereLike()](/database/query-builder/selects-and-filters#wherelike), [orWhereLike()](/database/query-builder/selects-and-filters#orwherelike), [whereNotLike()](/database/query-builder/selects-and-filters#wherenotlike), [orWhereNotLike()](/database/query-builder/selects-and-filters#orwherenotlike), [whereColumn()](/database/query-builder/selects-and-filters#wherecolumn), [orWhereColumn()](/database/query-builder/selects-and-filters#orwherecolumn), [whereAny()](/database/query-builder/selects-and-filters#whereany), [orWhereAny()](/database/query-builder/selects-and-filters#orwhereany), [whereAll()](/database/query-builder/selects-and-filters#whereall), [orWhereAll()](/database/query-builder/selects-and-filters#orwhereall), [whereNone()](/database/query-builder/selects-and-filters#wherenone), [orWhereNone()](/database/query-builder/selects-and-filters#orwherenone), [whereDate()](/database/query-builder/selects-and-filters#wheredate), [orWhereDate()](/database/query-builder/selects-and-filters#orwheredate), [whereMonth()](/database/query-builder/selects-and-filters#wheremonth), [orWhereMonth()](/database/query-builder/selects-and-filters#orwheremonth), [whereDay()](/database/query-builder/selects-and-filters#whereday), [orWhereDay()](/database/query-builder/selects-and-filters#orwhereday), [whereYear()](/database/query-builder/selects-and-filters#whereyear), [orWhereYear()](/database/query-builder/selects-and-filters#orwhereyear), [whereTime()](/database/query-builder/selects-and-filters#wheretime), [orWhereTime()](/database/query-builder/selects-and-filters#orwheretime), [wherePast()](/database/query-builder/selects-and-filters#wherepast), [orWherePast()](/database/query-builder/selects-and-filters#orwherepast), [whereNowOrPast()](/database/query-builder/selects-and-filters#wherenoworpast), [orWhereNowOrPast()](/database/query-builder/selects-and-filters#orwherenoworpast), [whereFuture()](/database/query-builder/selects-and-filters#wherefuture), [orWhereFuture()](/database/query-builder/selects-and-filters#orwherefuture), [whereNowOrFuture()](/database/query-builder/selects-and-filters#wherenoworfuture), [orWhereNowOrFuture()](/database/query-builder/selects-and-filters#orwherenoworfuture), [whereToday()](/database/query-builder/selects-and-filters#wheretoday), [orWhereToday()](/database/query-builder/selects-and-filters#orwheretoday), [whereBeforeToday()](/database/query-builder/selects-and-filters#wherebeforetoday), [orWhereBeforeToday()](/database/query-builder/selects-and-filters#orwherebeforetoday), [whereTodayOrBefore()](/database/query-builder/selects-and-filters#wheretodayorbefore), [orWhereTodayOrBefore()](/database/query-builder/selects-and-filters#orwheretodayorbefore), [whereAfterToday()](/database/query-builder/selects-and-filters#whereaftertoday), [orWhereAfterToday()](/database/query-builder/selects-and-filters#orwhereaftertoday), [whereTodayOrAfter()](/database/query-builder/selects-and-filters#wheretodayorafter), [orWhereTodayOrAfter()](/database/query-builder/selects-and-filters#orwheretodayorafter), [whereJson()](/database/query-builder/selects-and-filters#wherejson), [whereJsonContains()](/database/query-builder/selects-and-filters#wherejsoncontains), [whereJsonDoesntContain()](/database/query-builder/selects-and-filters#wherejsondoesntcontain), [orWhereJsonDoesntContain()](/database/query-builder/selects-and-filters#orwherejsondoesntcontain), [whereJsonContainsKey()](/database/query-builder/selects-and-filters#wherejsoncontainskey), [orWhereJsonContainsKey()](/database/query-builder/selects-and-filters#orwherejsoncontainskey), [whereJsonDoesntContainKey()](/database/query-builder/selects-and-filters#wherejsondoesntcontainkey), [orWhereJsonDoesntContainKey()](/database/query-builder/selects-and-filters#orwherejsondoesntcontainkey), [whereJsonLength()](/database/query-builder/selects-and-filters#wherejsonlength), [whereFullText()](/database/query-builder/selects-and-filters#wherefulltext), [whereVectorSimilarTo()](/database/query-builder/selects-and-filters#wherevectorsimilarto), [when()](/database/query-builder/selects-and-filters#when), [unless()](/database/query-builder/selects-and-filters#unless), [distinct()](/database/query-builder/selects-and-filters#distinct), [groupBy()](/database/query-builder/selects-and-filters#groupby), [having()](/database/query-builder/selects-and-filters#having), [orHaving()](/database/query-builder/selects-and-filters#orhaving), [havingBetween()](/database/query-builder/selects-and-filters#havingbetween), [orHavingBetween()](/database/query-builder/selects-and-filters#orhavingbetween), [havingNotBetween()](/database/query-builder/selects-and-filters#havingnotbetween), [orHavingNotBetween()](/database/query-builder/selects-and-filters#orhavingnotbetween), [havingNull()](/database/query-builder/selects-and-filters#havingnull), [orHavingNull()](/database/query-builder/selects-and-filters#orhavingnull), [havingNotNull()](/database/query-builder/selects-and-filters#havingnotnull), [orHavingNotNull()](/database/query-builder/selects-and-filters#orhavingnotnull), [unsafeWhere()](/database/query-builder/joins-and-subqueries#unsafewhere), [orUnsafeWhere()](/database/query-builder/joins-and-subqueries#orunsafewhere), [whereExists()](/database/query-builder/joins-and-subqueries#whereexists), [orWhereExists()](/database/query-builder/joins-and-subqueries#orwhereexists), [whereNotExists()](/database/query-builder/joins-and-subqueries#wherenotexists), [orWhereNotExists()](/database/query-builder/joins-and-subqueries#orwherenotexists), [whereInSub()](/database/query-builder/joins-and-subqueries#whereinsub), [whereNotInSub()](/database/query-builder/joins-and-subqueries#wherenotinsub), [whereSub()](/database/query-builder/joins-and-subqueries#wheresub), [orWhereSub()](/database/query-builder/joins-and-subqueries#orwheresub)

**Select columns:** [select()](/database/query-builder/selects-and-filters#select), [addSelect()](/database/query-builder/selects-and-filters#addselect), [selectSub()](/database/query-builder/joins-and-subqueries#selectsub), [addSelectSub()](/database/query-builder/joins-and-subqueries#addselectsub), [withCasts()](#withcasts)

**Joins and unions:** [join()](/database/query-builder/joins-and-subqueries#join), [leftJoin()](/database/query-builder/joins-and-subqueries#leftjoin), [rightJoin()](/database/query-builder/joins-and-subqueries#rightjoin), [crossJoin()](/database/query-builder/joins-and-subqueries#crossjoin), [joinSub()](/database/query-builder/joins-and-subqueries#joinsub), [leftJoinSub()](/database/query-builder/joins-and-subqueries#leftjoinsub), [rightJoinSub()](/database/query-builder/joins-and-subqueries#rightjoinsub), [joinLateral()](/database/query-builder/joins-and-subqueries#joinlateral), [leftJoinLateral()](/database/query-builder/joins-and-subqueries#leftjoinlateral), [union()](/database/query-builder/joins-and-subqueries#union), [unionAll()](/database/query-builder/joins-and-subqueries#unionall)

**Order, limit, and lock:** [orderBy()](/database/query-builder/selects-and-filters#orderby), [orderByDesc()](/database/query-builder/selects-and-filters#orderbydesc), [latest()](/database/query-builder/selects-and-filters#latest), [oldest()](/database/query-builder/selects-and-filters#oldest), [inRandomOrder()](/database/query-builder/selects-and-filters#inrandomorder), [reorder()](/database/query-builder/selects-and-filters#reorder), [limit()](/database/query-builder/selects-and-filters#limit), [offset()](/database/query-builder/selects-and-filters#offset), [skip()](/database/query-builder/selects-and-filters#skip), [take()](/database/query-builder/selects-and-filters#take), [forPage()](/database/query-builder/selects-and-filters#forpage), [lock()](/database/query-builder/selects-and-filters#lock), [lockForUpdate()](/database/query-builder/selects-and-filters#lockforupdate), [sharedLock()](/database/query-builder/selects-and-filters#sharedlock)

**Eager loading:** [with()](#with), [withCount()](#withcount), [withExists()](#withexists), [withSum()](#withsum), [withAvg()](#withavg), [withMin()](#withmin), [withMax()](#withmax), [withAggregate()](#withaggregate), [withWhereHas()](#withwherehas)

**Filter by relation:** [has()](#has), [orHas()](#orhas), [whereHas()](#wherehas), [orWhereHas()](#orwherehas), [doesntHave()](#doesnthave), [orDoesntHave()](#ordoesnthave), [whereDoesntHave()](#wheredoesnthave), [orWhereDoesntHave()](#orwheredoesnthave), [whereRelation()](#whererelation), [orWhereRelation()](#orwhererelation), [whereDoesntHaveRelation()](#wheredoesnthaverelation), [orWhereDoesntHaveRelation()](#orwheredoesnthaverelation), [hasMorph()](#hasmorph), [orHasMorph()](#orhasmorph), [doesntHaveMorph()](#doesnthavemorph), [orDoesntHaveMorph()](#ordoesnthavemorph), [whereHasMorph()](#wherehasmorph), [orWhereHasMorph()](#orwherehasmorph), [whereDoesntHaveMorph()](#wheredoesnthavemorph), [orWhereDoesntHaveMorph()](#orwheredoesnthavemorph), [whereMorphRelation()](#wheremorphrelation), [orWhereMorphRelation()](#orwheremorphrelation), [whereMorphDoesntHaveRelation()](#wheremorphdoesnthaverelation), [orWhereMorphDoesntHaveRelation()](#orwheremorphdoesnthaverelation), [whereBelongsTo()](#wherebelongsto), [orWhereBelongsTo()](#orwherebelongsto), [whereAttachedTo()](#whereattachedto), [orWhereAttachedTo()](#orwhereattachedto), [whereMorphedTo()](#wheremorphedto), [orWhereMorphedTo()](#orwheremorphedto), [whereNotMorphedTo()](#wherenotmorphedto), [orWhereNotMorphedTo()](#orwherenotmorphedto)

**Soft deletes:** [withTrashed()](#withtrashed), [onlyTrashed()](#onlytrashed), [withoutTrashed()](#withouttrashed)

**Global scopes:** [withoutGlobalScope()](#withoutglobalscope), [withoutGlobalScopes()](#withoutglobalscopes)

**Batching and pagination:** [chunk()](/database/query-builder/chunking), [chunkById()](/database/query-builder/chunking), [chunkByIdDesc()](/database/query-builder/chunking), [each()](/database/query-builder/chunking#each), [eachById()](/database/query-builder/chunking#eachbyid), [lazy()](/database/query-builder/chunking), [lazyById()](/database/query-builder/chunking#lazybyid), [lazyByIdDesc()](/database/query-builder/chunking#lazybyiddesc), [cursor()](/database/query-builder/chunking), [paginate()](/database/pagination#paginating-models), [paginateJson()](/database/pagination#paginating-models), [simplePaginate()](/database/pagination#paginating-models), [simplePaginateJson()](/database/pagination#paginating-models), [cursorPaginate()](/database/pagination#paginating-models), [cursorPaginateJson()](/database/pagination#paginating-models)

**Debug and cache:** [toSQL()](/database/query-builder/#value), [toRawSql()](/database/query-builder/#torawsql), [debug()](/database/query-builder/#value), [dump()](/database/query-builder/#value), [cache()](/database/query-builder/#value)

**Writes from a query:** [update()](/orm/writes#update-many-rows), [updateJson()](/orm/writes#update-json-columns), [increment()](/orm/writes#increment-and-decrement), [decrement()](/orm/writes#increment-and-decrement), [incrementEach()](/orm/writes#incrementeach), [decrementEach()](/orm/writes#decrementeach), [insertUsing()](/database/query-builder/writes#insertusing), [insertOrIgnoreUsing()](/database/query-builder/writes#insertorignoreusing), [truncate()](/orm/writes#truncate), [upsert()](/orm/writes#bulk-upserts), [delete()](/orm/writes#delete-records), [restore()](/orm/writes#soft-delete-and-restore), [forceDelete()](/orm/writes#soft-delete-and-restore)

**Loading behavior:** [preventLazyLoading()](#preventlazyloading), [preventAccessingMissingAttributes()](#preventaccessingmissingattributes), [automaticallyEagerLoadRelationships()](#automaticallyeagerloadrelationships)

**Model metadata:** [getTableName()](#gettablename), [getConnectionName()](#getconnectionname), [getRepository()](#getrepository)

**Instance checks and refresh:** [fresh()](#fresh), [refresh()](#refresh), [exists()](#exists), [is()](#is), [isNot()](#isnot), [trashed()](#trashed)

## Retrieve all records

```ts
const posts = await Post.all()

for (const post of posts) {
  console.log(post.title)
}
```

`all()` and `get()` return a [collection](/orm/collections), an array of model instances with extra helpers.

## Build a query

Start a query from any filter or ordering method on the model, then chain more:

```ts
const posts = await Post
  .where('status', 'published')
  .where('views', '>', 100)
  .latest()
  .get()
```

When the first method you need isn't available on the model itself, such as `limit()` or `take()`, start with `query()`:

```ts
const recent = await Post.query().latest().limit(5).get()
```

The model accepts the same filters as the [query builder](/database/query-builder/selects-and-filters): `whereIn`, `whereNull`, `whereBetween`, `whereLike`, date filters, JSON filters, joins, and more.

::: warning
Query builders are immutable. Each method returns a new builder and leaves the original unchanged, so always use the returned value:

```ts
let query = Post.query()
query = query.where('status', 'published')
```

Calling `query.where(...)` without reassigning it has no effect.
:::

### Conditional filters

Use `when()` to add a filter only when a value is present. The callback must return the query:

```ts
const posts = await Post
  .when(search, (query, term) => query.whereLike('title', `%${term}%`))
  .when(categoryId, (query, id) => query.where('category_id', id))
  .latest()
  .get()
```

`unless()` does the opposite and runs the callback when the value is falsy. Both accept a third callback for the other case.

### Grouped conditions

Pass a callback to `where()` to wrap conditions in parentheses:

```ts
const posts = await Post
  .where('status', 'published')
  .where(query => query
    .where('title', 'like', '%holo%')
    .orWhere('excerpt', 'like', '%holo%'))
  .get()
```

## Retrieve a single model

```ts
const post = await Post.find(1)
//    ^? Post | undefined

const first = await Post.where('status', 'draft').first()
const bySlug = await Post.firstWhere('slug', 'hello-world')
```

`find()` looks up by primary key. `findMany()` takes an array of keys and returns a collection:

```ts
const posts = await Post.findMany([1, 2, 3])
```

Find by a different column with `query().find()`:

```ts
const post = await Post.query().find('hello-world', 'slug')
```

### Not found errors

The `OrFail` methods throw a `ModelNotFoundException` instead of returning `undefined`:

```ts
const post = await Post.findOrFail(1)
const draft = await Post.where('status', 'draft').firstOrFail()
```

The error has `statusCode` set to `404` and a `model` property with the model name:

```ts
import { ModelNotFoundException } from '@holo-js/db'

try {
  await Post.findOrFail(id)
} catch (error) {
  if (error instanceof ModelNotFoundException) {
    console.log(error.model, error.statusCode)
  }
}
```

### Exactly one result

`sole()` returns the only matching row and throws when there are zero or more than one:

```ts
const settings = await Setting.where('key', 'site_name').sole()
```

## Single values and aggregates

```ts
const title = await Post.where('id', 1).value('title')
//    ^? string | undefined

const titles = await Post.where('status', 'published').pluck('title')
//    ^? string[]

const count = await Post.where('status', 'draft').count()
const totalViews = await Post.sum('views')
const averageViews = await Post.avg('views')
const hasDrafts = await Post.where('status', 'draft').exists()
```

`value()` returns `undefined` when no row matches. `valueOrFail()` throws instead, and `soleValue()` throws unless exactly one row matches. `min()`, `max()`, `doesntExist()` are also available. `avg()`, `min()`, and `max()` return `null` for an empty result.

## Select specific columns

```ts
const posts = await Post.select('id', 'title').get()
```

Alias a column with `as`:

```ts
const posts = await Post.select('id', 'title as heading').get()
```

## Ordering and limiting

```ts
await Post.orderBy('title').get()
await Post.orderBy('published_at', 'desc').get()
await Post.latest().get()
await Post.oldest('published_at').get()
await Post.inRandomOrder().first()
```

`latest()` and `oldest()` sort by `created_at` unless you pass a column. `reorder()` clears earlier ordering.

```ts
await Post.query().latest().skip(20).take(10).get()
await Post.query().latest().forPage(3, 10).get()
```

## Pagination

```ts
const page = await Post.where('status', 'published').latest().paginate(15, 2)

page.data
page.meta.total
page.meta.lastPage
```

`simplePaginate()` skips the total count, and `cursorPaginate()` pages by cursor for large tables. See [pagination](/database/pagination) for the full result shape.

## Soft-deleted models

On models with [soft deletes](/orm/#soft-deletes), queries skip trashed rows automatically. Include them explicitly:

```ts
const everything = await Post.withTrashed().get()
const trashed = await Post.onlyTrashed().get()
```

On a query, `withoutTrashed()` switches back to the default. Check a single record with `post.trashed()`.

## Remove global scopes

If the model has [global scopes](/orm/scopes#global-scopes), turn them off per query:

```ts
await Post.withoutGlobalScope('published').get()
await Post.withoutGlobalScopes().get()
await Post.withoutGlobalScopes(['published', 'tenant']).get()
```

## Process large tables

Don't load thousands of rows with `get()`. Process them in batches instead.

`chunkById()` reads batches ordered by primary key and is safe when you update rows inside the callback:

```ts
await Post.where('status', 'draft').chunkById(200, async (posts) => {
  for (const post of posts) {
    await post.update({ status: 'archived' })
  }
})
```

Return `false` from the callback to stop early. `chunk()` reads batches in primary key order, `chunkById()` orders by a column you name, and `chunkByIdDesc()` walks keys in reverse.

`lazy()` yields one model at a time while fetching in batches behind the scenes:

```ts
for await (const post of Post.lazy(500)) {
  await reindex(post)
}
```

`each()` calls a function once per model, and `eachById()` and `lazyById()` batch by primary key so you can update models while you walk them:

```ts
await Post.where('status', 'draft').eachById(async (post) => {
  await post.update({ status: 'archived' })
})
```

See [chunking large results](/database/query-builder/chunking) for more.

## Models from rows you already loaded

`hydrate()` turns a row you read with the [query builder](/database/query-builder/) into a saved model, as `find()` would have returned it. Use it when the row has to come from somewhere the model can't query, such as a transaction on another connection:

```ts
await DB.transaction(async (tx) => {
  const row = await tx.table(Tenant.definition.table).where('id', tenantId).lockForUpdate().first()
  if (!row) {
    return
  }

  const tenant = await Tenant.hydrate(row, tx)
  await actor.policy('tenants').authorize('manageTeam', tenant)
})
```

The model reads the row the way a query does: it applies casts, fires the `retrieved` [event](/orm/observers), and reports `exists()` as `true` with no changes. Pass the source connection as the second argument when its driver differs from the model's driver, so values such as JSON are decoded correctly. Without it, decoding uses the model's driver. Relations, policies, and media work as they do on a model from `find()`, and they run on the model's own connection. `fillable` and `guarded` don't apply, because the row comes from the database, not from a request. Pass it only rows you read from the model's table. To build a new, unsaved model, use [`make()`](/orm/writes#make).

## Plain JSON results

Methods ending in `Json` return plain serialized objects instead of model instances: `getJson()`, `firstJson()`, `findOrFailJson()`, `soleJson()`, `paginateJson()`, `simplePaginateJson()`, and `cursorPaginateJson()`.

```ts
const posts = await Post.where('status', 'published').getJson()
```

They apply your `hidden`, `visible`, and `appended` settings. See [serialization](/orm/serialization).

## Cache query results

Add `cache()` with a number of seconds to cache a query's results:

```ts
const categories = await Category.orderBy('name').cache(60).get()
```

See [query caching](/cache/query-caching).

## Refresh a model

`fresh()` loads a new copy of the record from the database. `refresh()` reloads the current instance in place and clears its loaded relationships.

```ts
const latest = await post.fresh()
await post.refresh()
```

## Compare models

`is()` checks whether two instances are the same row on the same table and connection:

```ts
if (post.is(otherPost)) {
  // same record
}
```

`isNot()` is the reverse.

## Debug a query

```ts
const { sql, bindings } = Post.where('status', 'draft').toSQL()
```

`debug()` adds the connection name and redacts sensitive bindings, which makes it safer to log. `dump()` prints the `debug()` output and returns the query so you can keep chaining.

## Method reference

Model-level methods are described here. Shared query builder methods are documented on the [query builder pages](/database/query-builder/).

### query()

Starts a query for the model. Soft-deleted rows are excluded, global scopes apply, and the relations in the model's `with` option load automatically.

```ts
const posts = await Post.query().where('status', 'published').get()
```

### newQuery()

Alias of `query()`. It builds the same query with the same defaults.

### newModelQuery()

Alias of `query()`. It builds the same query with the same defaults.

### newQueryWithoutScopes()

Starts a query with global scopes and the soft-delete filter turned off. The model's default `with` relations still load.

```ts
const everyPost = await Post.newQueryWithoutScopes().get()
```

### newQueryWithoutRelationships()

Starts a query that skips the model's default `with` relations. Soft-delete filtering and global scopes still apply.

```ts
const bareRows = await Post.newQueryWithoutRelationships().get()
```

### all()

Returns every visible row as a [collection](/orm/collections). It's the same as `get()` with no filters.

```ts
const posts = await Post.all()
```

### get()

Runs the query and returns a [collection](/orm/collections) of models.

```ts
const drafts = await Post.where('status', 'draft').get()
```

### first()

Returns the first matching model, or `undefined`.

```ts
const latest = await Post.latest().first()
```

### firstOrFail()

Returns the first matching model. Throws `ModelNotFoundException` when nothing matches.

```ts
const post = await Post.where('slug', slug).firstOrFail()
```

### find()

Returns one model by primary key, or `undefined`. Pass a second argument to look up by another column.

```ts
const post = await Post.query().find('hello-world', 'slug')
```

### findMany()

Returns a collection of models with the given primary keys. An empty array returns an empty collection without querying the database.

```ts
const posts = await Post.findMany([1, 2, 3])
```

### findOrFail()

Like `find()`, but throws `ModelNotFoundException` when no row matches.

```ts
const post = await Post.findOrFail(1)
```

### findOr()

Returns one model by primary key, or the result of the callback when no row matches.

```ts
const post = await Post.findOr(id, () => Post.make({ title: 'Untitled' }))
```

### firstOr()

Returns the first matching model, or the result of the callback when nothing matches.

```ts
const post = await Post.where('slug', slug).firstOr(() => {
  throw new Error(`No post for ${slug}`)
})
```

### findOrNew()

Returns one model by primary key, or a new unsaved model when no row matches.

```ts
const settings = await Setting.findOrNew(userId)
```

### whereKey()

Filters by primary key. Pass one key or a list.

```ts
const posts = await Post.whereKey([1, 2, 3]).get()
```

### whereKeyNot()

Filters out one primary key or a list of them.

```ts
const others = await Post.whereKeyNot(post.get('id')).get()
```

### firstWhere()

Shorthand for `where(column, operator, value).first()`.

```ts
const post = await Post.firstWhere('slug', '=', 'hello-world')
```

### sole()

Returns the only matching model. Throws when no row matches or when more than one does. See [exactly one result](#exactly-one-result).

```ts
const settings = await Setting.where('key', 'site_name').sole()
```

### hydrate()

Builds a saved model from a row of the model's table that you already loaded, applying casts and firing the `retrieved` event. Mass assignment rules don't apply. See [models from rows you already loaded](#models-from-rows-you-already-loaded).

The optional second argument is the source `DatabaseContext`, such as a transaction's `tx`. It controls decoding without changing the model's connection.

```ts
const tenant = await Tenant.hydrate(row)
```

### getJson()

Returns every matching row as a plain object, serialized with the model's `hidden`, `visible`, and `appended` rules.

```ts
const posts = await Post.getJson()
```

### firstJson()

Returns the first matching row as a plain object, or `undefined`.

```ts
const latest = await Post.latest().firstJson()
```

### findOrFailJson()

Returns one row as a plain object by primary key. Throws `ModelNotFoundException` when no row matches.

```ts
return await Post.findOrFailJson(id)
```

### soleJson()

Returns the only matching row as a plain object. Throws when zero or several rows match.

```ts
const settings = await Setting.where('key', 'site_name').soleJson()
```

### with()

Eager loads relations in the same query. Pass a constraint callback to filter one relation's rows. See [eager loading](/orm/relationships/loading).

```ts
const posts = await Post
  .with('author', 'tags')
  .with('comments', query => query.where('approved', true))
  .get()
```

### withCount()

Adds a `{relation}_count` attribute to each model, without loading the related rows.

```ts
const posts = await Post.withCount('comments').get()
// posts[0].comments_count
```

### withExists()

Adds a `{relation}_exists` boolean to each model. It's `true` when at least one related row matches.

```ts
const authors = await Author.withExists('posts').get()
// authors[0].posts_exists
```

### withSum()

Adds a `{relation}_sum_{column}` attribute with the total of a related column.

```ts
const authors = await Author.withSum('books', 'pages').get()
// authors[0].books_sum_pages
```

### withAvg()

Adds a `{relation}_avg_{column}` attribute with the average of a related column.

```ts
const authors = await Author.withAvg('books', 'rating').get()
```

### withMin()

Adds a `{relation}_min_{column}` attribute with the smallest value of a related column.

```ts
const authors = await Author.withMin('books', 'pages').get()
```

### withMax()

Adds a `{relation}_max_{column}` attribute with the largest value of a related column.

```ts
const authors = await Author.withMax('books', 'pages').get()
```

### withAggregate()

Adds a `{relation}_{function}_{column}` attribute using the aggregate function you name: `count`, `exists`, `sum`, `avg`, `min`, or `max`. `withSum()`, `withAvg()`, `withMin()`, `withMax()`, `withCount()`, and `withExists()` are shortcuts for it. With `count` and `exists`, the column must be `'*'`, and the attribute is named `{relation}_count` or `{relation}_exists`.

```ts
const authors = await Author.withAggregate('books', 'pages', 'sum').get()
// author.toJSON().books_sum_pages
```

### withWhereHas()

Keeps only models that have a matching related row, and eager loads that same filtered relation.

```ts
const authors = await Author
  .withWhereHas('posts', query => query.where('status', 'published'))
  .get()
```

### has()

Keeps only models that have at least one related row.

```ts
const authorsWithPosts = await Author.has('posts').get()
```

### orHas()

Adds an `or` condition: the model matches if it has at least one related row. Use it after another `where` clause.

```ts
const authors = await Author.where('active', true).orHas('posts').get()
```

### whereHas()

Keeps models with a related row that matches the constraint callback.

```ts
const authors = await Author
  .whereHas('posts', query => query.where('status', 'published'))
  .get()
```

### orWhereHas()

Adds an `or` version of `whereHas()`.

```ts
const authors = await Author
  .where('active', true)
  .orWhereHas('posts', query => query.where('status', 'published'))
  .get()
```

### doesntHave()

Keeps only models with no related rows.

```ts
const authorsWithoutPosts = await Author.doesntHave('posts').get()
```

### orDoesntHave()

Adds an `or` version of `doesntHave()`.

```ts
const authors = await Author.where('vip', true).orDoesntHave('posts').get()
```

### whereDoesntHave()

Keeps models with no related row that matches the constraint callback.

```ts
const authors = await Author
  .whereDoesntHave('posts', query => query.where('status', 'draft'))
  .get()
```

### orWhereDoesntHave()

Adds an `or` version of `whereDoesntHave()`.

```ts
const authors = await Author
  .where('vip', true)
  .orWhereDoesntHave('posts', query => query.where('status', 'draft'))
  .get()
```

### whereRelation()

Shorthand for `whereHas()` with one column condition on the related model.

```ts
const authors = await Author.whereRelation('posts', 'status', 'published').get()
```

### orWhereRelation()

Adds an `or` version of `whereRelation()`.

```ts
const authors = await Author
  .where('vip', true)
  .orWhereRelation('posts', 'status', 'published')
  .get()
```

### whereDoesntHaveRelation()

Shorthand for `whereDoesntHave()` with one column condition on the related model.

```ts
const authors = await Author.whereDoesntHaveRelation('posts', 'status', 'published').get()
```

### orWhereDoesntHaveRelation()

Adds an `or` version of `whereDoesntHaveRelation()`.

```ts
const authors = await Author
  .where('vip', true)
  .orWhereDoesntHaveRelation('posts', 'status', 'published')
  .get()
```

### hasMorph()

Keeps rows whose `morphTo` relation points at an existing model of one of the given types.

```ts
const comments = await Comment.hasMorph('commentable', [Post, Video]).get()
```

### orHasMorph()

Adds an `or` version of `hasMorph()`.

```ts
const comments = await Comment.where('pinned', true).orHasMorph('commentable', Post).get()
```

### doesntHaveMorph()

Keeps rows whose `morphTo` relation does not point at an existing model of the given types.

```ts
const comments = await Comment.doesntHaveMorph('commentable', Post).get()
```

### orDoesntHaveMorph()

Adds an `or` version of `doesntHaveMorph()`.

```ts
const comments = await Comment.where('pinned', true).orDoesntHaveMorph('commentable', Post).get()
```

### whereHasMorph()

Like `hasMorph()`, with a constraint on the related model.

```ts
const comments = await Comment
  .whereHasMorph('commentable', [Post, Video], query => query.where('status', 'published'))
  .get()
```

### orWhereHasMorph()

Adds an `or` version of `whereHasMorph()`.

```ts
const comments = await Comment
  .where('pinned', true)
  .orWhereHasMorph('commentable', Post, query => query.where('status', 'published'))
  .get()
```

### whereDoesntHaveMorph()

Like `doesntHaveMorph()`, with a constraint on the related model.

```ts
const comments = await Comment
  .whereDoesntHaveMorph('commentable', Post, query => query.where('status', 'draft'))
  .get()
```

### orWhereDoesntHaveMorph()

Adds an `or` version of `whereDoesntHaveMorph()`.

```ts
const comments = await Comment
  .where('pinned', true)
  .orWhereDoesntHaveMorph('commentable', Post, query => query.where('status', 'draft'))
  .get()
```

### whereMorphRelation()

Like `whereRelation()`, for a `morphTo` relation. Pass the model types the relation may point at.

```ts
const comments = await Comment
  .whereMorphRelation('commentable', [Post, Video], 'status', 'published')
  .get()
```

### orWhereMorphRelation()

Adds an `or` version of `whereMorphRelation()`.

```ts
const comments = await Comment
  .where('flagged', true)
  .orWhereMorphRelation('commentable', Post, 'status', 'published')
  .get()
```

### whereMorphDoesntHaveRelation()

Like `whereDoesntHaveRelation()`, for a `morphTo` relation. Pass the model types the relation may point at.

```ts
const comments = await Comment
  .whereMorphDoesntHaveRelation('commentable', [Post, Video], 'status', 'draft')
  .get()
```

### orWhereMorphDoesntHaveRelation()

Adds an `or` version of `whereMorphDoesntHaveRelation()`.

```ts
const comments = await Comment
  .where('flagged', true)
  .orWhereMorphDoesntHaveRelation('commentable', Post, 'status', 'draft')
  .get()
```

### whereBelongsTo()

Keeps rows whose `belongsTo` relation points at the given model. Pass the relation name when the model has more than one `belongsTo` relation to that model.

```ts
const posts = await Post.whereBelongsTo(author, 'author').get()
```

### orWhereBelongsTo()

Adds an `or` version of `whereBelongsTo()`.

```ts
const posts = await Post.where('pinned', true).orWhereBelongsTo(author, 'author').get()
```

### whereAttachedTo()

Keeps rows attached to the given model, or to any model in a list, through a many-to-many relation. Pass the relation name when the model has more than one many-to-many relation to that model.

```ts
const posts = await Post.whereAttachedTo(tag).get()
const tagged = await Post.whereAttachedTo([news, tips], 'tags').get()
```

### orWhereAttachedTo()

Adds an `or` version of `whereAttachedTo()`.

```ts
const posts = await Post.where('pinned', true).orWhereAttachedTo(tag).get()
```

### whereMorphedTo()

Keeps rows whose `morphTo` relation points at the given model, entity, or morph type.

```ts
const comments = await Comment.whereMorphedTo('commentable', post).get()
```

### orWhereMorphedTo()

Adds an `or` version of `whereMorphedTo()`.

```ts
const comments = await Comment
  .where('flagged', true)
  .orWhereMorphedTo('commentable', post)
  .get()
```

### whereNotMorphedTo()

Keeps rows whose `morphTo` relation does not point at the given model or type.

```ts
const comments = await Comment.whereNotMorphedTo('commentable', Video).get()
```

### orWhereNotMorphedTo()

Adds an `or` version of `whereNotMorphedTo()`.

```ts
const comments = await Comment
  .where('flagged', true)
  .orWhereNotMorphedTo('commentable', Video)
  .get()
```

### withTrashed()

Includes soft-deleted rows in the query.

```ts
const everything = await Post.withTrashed().get()
```

### onlyTrashed()

Returns only soft-deleted rows.

```ts
const trashed = await Post.onlyTrashed().get()
```

### withoutTrashed()

Excludes soft-deleted rows. Use it to undo `withTrashed()` or `onlyTrashed()` earlier in the chain.

```ts
const active = await Post.withoutTrashed().get()
```

### withoutGlobalScope()

Runs the query with one named [global scope](/orm/scopes#global-scopes) turned off. Call it first in the chain. It starts a new query, so filters added before it are dropped.

```ts
const posts = await Post.withoutGlobalScope('published').get()
```

### withoutGlobalScopes()

Turns off the named global scopes, or every global scope when you pass no names. Without names, it also removes the soft-delete filter, so trashed rows are included. Call it first in the chain.

```ts
await Post.withoutGlobalScopes(['published', 'tenant']).get()
```

### withCasts()

Adds casts that apply only to this query's results. Use it for computed columns that the model doesn't cast.

```ts
const users = await User.withCasts({ lastPostedAt: 'date' }).get()
```

### preventLazyLoading()

Turns on, or with `false` turns off, the check that throws when a relation is read without being eager loaded. See [preventing lazy loading](/orm/relationships/loading#preventing-lazy-loading).

```ts
Post.preventLazyLoading()
```

### preventAccessingMissingAttributes()

Turns on, or with `false` turns off, the check that throws when a column that wasn't selected is read.

```ts
Post.preventAccessingMissingAttributes()
```

### automaticallyEagerLoadRelationships()

Turns on, or with `false` turns off, automatic eager loading. The first access to a relation loads it for the whole result set. See [automatic eager loading](/orm/relationships/loading#automatic-eager-loading).

```ts
Post.automaticallyEagerLoadRelationships()
```

### getTableName()

Returns the table name the model reads from.

```ts
Post.getTableName()
// 'posts'
```

### getConnectionName()

Returns the connection name from the model's `connectionName` option, or `undefined` when it uses the default connection.

```ts
Post.getConnectionName()
```

### getRepository()

Returns the model's internal repository, which runs its queries. App code rarely needs it.

### fresh()

Returns a new copy of the record from the database, or `undefined` if the row no longer exists. The current instance is not changed.

```ts
const latest = await post.fresh()
```

### refresh()

Reloads the record into the current instance and clears its loaded relations. It throws if the instance was never saved.

```ts
await post.refresh()
```

### exists()

Returns `true` when the instance was loaded from the database or saved to it. A model made with `make()` returns `false` until you save it.

```ts
if (!post.exists()) {
  await post.save()
}
```

### is()

Returns `true` when the other instance is the same row, on the same table and connection.

```ts
post.is(otherPost)
```

### isNot()

Returns `true` when the other instance is a different row.

```ts
if (post.isNot(otherPost)) {
  // different records
}
```

### trashed()

Returns `true` when the record has a `deleted_at` value. Models without soft deletes always return `false`.

```ts
if (post.trashed()) {
  // show a restore button
}
```

## Next steps

- [Creating and updating](/orm/writes)
- [Scopes](/orm/scopes)
- [Eager loading and aggregates](/orm/relationships/loading)
- [Collections](/orm/collections)
