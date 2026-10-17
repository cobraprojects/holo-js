# Abilities

An ability is a named rule that isn't about one model: exporting a report, viewing the billing dashboard, running a bulk import. Put each ability in `server/abilities`, and Holo picks it up automatically. For rules about a model or record, use a [policy](/authorization/policies) instead.

## Write an ability

```ts [server/abilities/exportReports.ts]
import { allow, defineAbility, deny } from '@holo-js/authorization'

export default defineAbility('reports.export', ({ user }, input: {
  reportId: string
  format: 'csv' | 'pdf'
}) => {
  if (!user) {
    return deny('Sign in to export reports.')
  }

  if (user.role === 'admin') {
    return allow()
  }

  return input.format === 'csv'
    ? allow()
    : deny('Only admins can export PDFs.')
})
```

`defineAbility()` takes a unique name and a handler. The handler gets the same context as a policy rule (`user`, `authenticated`, and sometimes `guard`) plus an input you define. It returns the same values as a policy rule: `true`, `false`, `allow()`, `deny()`, or `denyAsNotFound()`, directly or from a promise.

Export one ability per file, as the default export.

## Check an ability

Select the ability with `.ability(name)`, then call `authorize()`, `can()`, `cannot()`, or `inspect()` with the input:

```ts
import authorization from '@holo-js/authorization'

await authorization.forUser(user).ability('reports.export').authorize({
  reportId: 'rpt_42',
  format: 'pdf',
})
```

With [auth](/auth/) installed, use `authorization.guard()` to check the signed-in user of a guard:

```ts
const allowed = await authorization.guard('web').ability('reports.export').can({
  reportId: 'rpt_42',
  format: 'csv',
})
```

The input type comes from your handler, so the object you pass is type-checked and autocompleted once Holo has generated types. Run `npx holo prepare` if a new ability doesn't autocomplete yet.

## Use the decision

`inspect()` returns the decision instead of throwing, which is handy for showing or hiding a button:

```ts
const decision = await authorization.forUser(user).ability('reports.export').inspect({
  reportId: 'rpt_42',
  format: 'pdf',
})

if (!decision.allowed) {
  return Response.json({ message: decision.message }, { status: decision.status })
}
```

## Name abilities

Ability names are plain strings. A `area.action` pattern such as `reports.export` or `billing.view` keeps them easy to scan. Checking a name that doesn't exist throws `AuthorizationAbilityNotFoundError`.

## Next steps

- [Policies](/authorization/policies)
- [Using with Auth](/authorization/with-auth)
- [Denied Responses (403 vs 404)](/authorization/errors)
