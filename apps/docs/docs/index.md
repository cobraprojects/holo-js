---
layout: home

hero:
  name: Holo-JS
  text: The backend your framework is missing
  tagline: Database, ORM, auth, queues, mail, storage, and realtime for Next.js, Nuxt, and SvelteKit. Keep your framework's routing and rendering. Add the backend.
  image:
    src: /mark.svg
    alt: Holo-JS
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/quick-start
    - theme: alt
      text: Tutorial
      link: /tutorial/
    - theme: alt
      text: GitHub
      link: https://github.com/cobraprojects/holo-js

features:
  - title: Database and Migrations
    details: SQLite, Postgres, and MySQL with migrations, seeders, transactions, and a fluent query builder.
    link: /database/
  - title: ORM Models
    details: Typed models with relationships, scopes, casts, observers, and factories. Column names autocomplete.
    link: /orm/
  - title: Validation and Forms
    details: One schema validates on the server and the client, with typed errors and framework form helpers.
    link: /basics/forms/
  - title: Authentication
    details: Login, registration, sessions, email verification, password reset, MFA, API tokens, and social login.
    link: /auth/
  - title: Authorization
    details: Policies and abilities that work with or without auth, and return 403 or 404 the way you choose.
    link: /authorization/
  - title: Security
    details: CSRF protection, rate limiting, and CORS, wired into each framework's middleware.
    link: /basics/security/
  - title: Queues and Jobs
    details: Run work in the background with sync, database, or Redis drivers. Retry and inspect failed jobs.
    link: /queue/
  - title: Events
    details: Dispatch domain events, react with listeners, queue them, or wait until the transaction commits.
    link: /events/
  - title: Mail and Notifications
    details: Write mail in code or Markdown, preview it in the browser, and send notifications by email, database, broadcast, or your own channel.
    link: /mail/
  - title: Cache
    details: File, memory, Redis, or database cache stores, with locks and cached queries.
    link: /cache/
  - title: Files and Media
    details: Local, public, and S3 disks, plus a media library that attaches files and image conversions to models.
    link: /storage/
  - title: Broadcasting and Realtime
    details: Push events to the browser over WebSockets, and keep query results live without writing socket code.
    link: /broadcasting/
---

## A quick taste

Define a model for an existing table:

```ts [server/models/Post.ts]
import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('posts', {
  fillable: ['title', 'body', 'status'],
  relations: {
    comments: hasMany('Comment', { foreignKey: 'post_id' }),
  },
})
```

Then query it from any server route. Column names and results are typed from your migrations:

```ts
import Post from './server/models/Post'

const posts = await Post
  .with('comments')
  .where('status', 'published')
  .latest()
  .paginate(10)

const draft = await Post.create({
  title: 'Hello Holo',
  body: 'My first post.',
  status: 'draft',
})
```

[Start the Quick Start](/getting-started/quick-start) to build this in about ten minutes.
