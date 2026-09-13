---
name: holo-forms-validation
description: Implement or review Holo-JS schemas, request validation, form state, error handling, and framework form integration.
metadata:
  type: focused
  source: https://docs.holo-js.com/forms/framework-integration
---

# Forms and validation

Use one shared Holo schema as the contract between the browser and server. Read [forms](https://docs.holo-js.com/forms/), [client usage](https://docs.holo-js.com/forms/client-usage), [server validation](https://docs.holo-js.com/forms/server-validation), and [framework integration](https://docs.holo-js.com/forms/framework-integration).

## Workflow

1. Define the schema in code importable by both client and server.
2. Infer request data from that schema instead of duplicating an interface.
3. Let the framework adapter serialize `ValidationException` into its native response shape.
4. Validate the raw request or action input before authorization-sensitive writes.
5. Bind the same schema to `useForm` on the client and render structured field errors.

```ts
import { field, schema, type InferValidationSchemaData } from '@holo-js/validation'

export const createPostForm = schema({
  title: field.string().required().min(3).max(160),
  body: field.string().required().min(1),
})

export type CreatePostRequest = InferValidationSchemaData<typeof createPostForm>
```

```ts
const data = await validate(request, createPostForm)
const post = await Post.create(data)
```

```ts
const form = useForm(createPostForm, { initialValues: { title: '', body: '' } })
```

## Boundaries

- Do not maintain a custom validation registry beside the adapter's `ValidationException` handling.
- Do not parse the same payload independently in the route and service.
- Do not turn validation errors into generic 500 responses.
- Do not import a server-only module into a browser bundle. Shared schema modules must remain browser-safe.
- For Next.js, Nuxt, or SvelteKit response mechanics, also read the matching framework skill.

## Completion check

- Client and server use the same schema object.
- Validated data remains concretely inferred.
- Invalid input returns the adapter's documented structured errors.
- Tests cover success, invalid fields, and browser/server schema compatibility.
