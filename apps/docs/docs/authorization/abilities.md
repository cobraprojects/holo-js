# Abilities

Abilities handle named authorization decisions that are not tied to a single model instance.

## Ability shape

```ts
import { defineAbility, allow, deny } from '@holo-js/authorization'

export default defineAbility('reports.export', (context, input: {
  reportId: string
  format: 'csv' | 'pdf'
}) => {
  if (!context.user) {
    return deny('You must be signed in to export reports.')
  }

  if (context.user.role === 'admin') {
    return allow()
  }

  return input.format === 'csv'
})
```

The ability name is the registry key. Holo uses it to generate typed discovery output and autocomplete.

## When to use abilities

Use abilities when the action is not naturally a policy on a record.

Examples:

- report exports
- publishing workflows
- batch operations
- custom business actions

If you are checking a model instance, use a policy instead.

## Typed inputs

Ability inputs are inferred from the handler. That means the payload you pass into `authorize(...)`, `can(...)`, or
`inspect(...)` stays safe and autocompleted.

```ts
const decision = await authorization.forUser(user).ability('reports.export').inspect({
  reportId: 'rpt-1',
  format: 'csv',
})

if (!decision.allowed) {
  return Response.json({ message: decision.message }, { status: decision.status })
}
```

## Discovery and typing

Ability files belong in `server/abilities`. The CLI discovers them, generates typed registry artifacts, and gives
you autocomplete for:

- ability names
- ability input shapes

## Continue

- [Policies](/authorization/policies)
- [Standalone Mode](/authorization/standalone-mode)
- [Auth Integration](/authorization/auth-integrated-mode)
