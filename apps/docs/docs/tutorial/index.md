# Build a Blog

In this tutorial you build a complete blog with Holo-JS, one small step at a time. You write the database, the public pages, an admin area, sign-in, permissions, image uploads, and live updates, then test and ship it.

You can follow along with Next.js, Nuxt, or SvelteKit. Pick your framework in any code tab and the site remembers it on every page.

## What you'll build

By the end you'll have a blog with:

- a public home page, a post list, and a page for each post
- category and tag archive pages
- an admin area to create, edit, and delete posts, categories, and tags
- forms that check input on the server and show errors next to each field
- registration, sign-in, and sign-out
- rules for who can create, publish, edit, and delete posts
- a featured image for each post, with a resized thumbnail
- an admin dashboard that updates live when posts change
- a test for the main post workflow, and a production build

The finished code lives in the Holo-JS repository, so you can compare your work at any point:

- [`apps/blog-next`](https://github.com/cobraprojects/holo-js/tree/main/apps/blog-next)
- [`apps/blog-nuxt`](https://github.com/cobraprojects/holo-js/tree/main/apps/blog-nuxt)
- [`apps/blog-sveltekit`](https://github.com/cobraprojects/holo-js/tree/main/apps/blog-sveltekit)

The finished apps include a few extras this tutorial skips, such as social login, API tokens, comments, and a second "super admin" sign-in. The tutorial code is a trimmed version of the same app.

## Before you start

You need:

- Node.js 22.14 or newer on the 22 line, or Node.js 24 or 26
- npm (or another package manager; see [Installation](/getting-started/installation)). On Node.js 22, Nuxt projects installed with npm need npm 11
- basic knowledge of your framework: pages, server code, and forms
- a terminal and a code editor

You don't need a database server. The tutorial uses SQLite, which stores everything in a file inside your project.

## Chapters

Each chapter ends with a working app and a "Check it works" step.

| # | Chapter | You'll add |
| --- | --- | --- |
| 1 | [Create the Project](/tutorial/create-project) | A new Holo-JS app with all the packages the blog needs |
| 2 | [Database and Migrations](/tutorial/database-and-migrations) | Tables for categories, tags, posts, and post tags |
| 3 | [Models and Queries](/tutorial/models-and-queries) | Models, relationships, sample data, and read queries |
| 4 | [Public Pages](/tutorial/public-pages) | Home, post list, post detail, and archive pages |
| 5 | [Admin CRUD](/tutorial/admin-crud) | An admin dashboard and category, tag, and post management |
| 6 | [Forms and Validation](/tutorial/forms-and-validation) | A validated post form with field errors |
| 7 | [Authentication](/tutorial/auth) | Register, sign in, sign out, and a protected admin area |
| 8 | [Authorization](/tutorial/authorization) | Policies for creating, publishing, editing, and deleting |
| 9 | [Media Uploads](/tutorial/media-uploads) | Featured images with a thumbnail conversion |
| 10 | [Realtime and Notifications](/tutorial/realtime-and-notifications) | Live admin updates, events, jobs, and auth emails |
| 11 | [Testing and Deployment](/tutorial/testing-and-deployment) | An automated test and a production build |

## How long it takes

Plan for about three to four hours in total. Most chapters take 15 to 25 minutes. You can stop after any chapter and pick up later, because each one leaves the app working.

## How the code is organized

Holo-JS runs inside your framework. Your framework still handles pages, routing, and rendering. Holo adds the backend: database, models, auth, queues, storage, and more.

Throughout the tutorial you'll keep a clear split:

- **`server/`** holds Holo code: models, migrations, policies, events, jobs.
- **`server/lib/blog.ts`** (or `src/lib/server/blog.ts` in SvelteKit) holds the blog's read and write functions.
- **Framework files** (pages, server actions, API routes, form actions) call those functions.

This keeps each page small and lets you reuse the same logic from tests.

## Next steps

Start with [Create the Project](/tutorial/create-project).
