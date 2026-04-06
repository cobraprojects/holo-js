# Routing

Holo-JS does not replace routing or SSR. The host framework keeps owning request flow and rendering.
Holo-JS provides backend services for the server side of that runtime.

## What the host framework still owns

- route matching
- SSR
- page rendering
- server action or handler conventions
- deployment output

## What Holo-JS owns in that flow

- typed models
- `DB` access
- storage and media services
- CLI workflows
- generated discovery registries

## Route locations by framework

Nuxt:

```text
server/api/
```

Next.js:

```text
app/api/
```

SvelteKit:

```text
src/routes/
```

Use the normal server route conventions for the selected framework. Holo-JS does not create a second
router on top of them.

## Route responsibilities

A good route handler usually does four things:

1. read request input
2. call a model, DB query, or storage service
3. shape the response
4. return the result

If a route starts knowing too much about columns, relation keys, or file path rules, move that behavior
into models, storage services, or server-side application services.

## Practical rule

Treat Holo-JS services as backend dependencies used inside server handlers. Treat the host framework as
the owner of HTTP and rendering.
