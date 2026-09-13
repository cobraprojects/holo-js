# High-risk conversion examples

These pairs mark the boundary between using Holo-JS as the framework and wrapping it in another framework.

## Request validation

Avoid a registry or action factory that hides the schema and `validate()` call:

```ts
const data = await validationRegistry.validate('posts.create', request)
```

Use the shared schema directly:

```ts
const data = await validate(request, createPostForm)
```

## Schema-derived types

Avoid a handwritten type that duplicates the schema:

```ts
type CreatePostRequest = {
  title: string
  body: string
}
```

Derive the type when a named type is useful:

```ts
type CreatePostRequest = InferValidationSchemaData<typeof createPostForm>
```

Prefer direct inference from `validate()` when no named type is needed.

## Model queries

Avoid a generic application repository that only forwards Holo calls:

```ts
const post = await repositories.for(Post).create(data)
const posts = await repositories.for(Post).query({ status: 'published' })
```

Use the model API directly:

```ts
const post = await Post.create(data)
const posts = await Post.where('status', 'published').latest().get()
```

A domain service remains useful when it owns a business operation rather than forwarding CRUD calls.

## Complete removal

Replacing production imports is only the middle of a conversion. Search tests, seeds, scripts, generated snapshots, migrations, package exports, and configuration for the old path. Remove every artifact made obsolete by the conversion. Keep an exception only when an active external contract requires it, and report that exception by file and contract.
