import { defineSeeder } from '@holo-js/db'

import Post from '../../models/Post'
import User from '../../models/User'
import Category from '../../models/Category'
import Tag from '../../models/Tag'

export default defineSeeder({
  name: 'BlogSeeder',
  async run() {
    const timestamp = new Date('2026-04-26T09:00:00.000Z')

    const author = await User.unguarded(() =>
      User.create({
        name: 'Holo Editor',
        email: 'editor@example.com',
        password: 'secret',
        avatar: null,
        email_verified_at: timestamp,
      }),
    )

    const engineering = await Category.create({
      name: 'Engineering',
      slug: 'engineering',
      description: 'Architecture notes, patterns, and release updates.',
    })

    const product = await Category.create({
      name: 'Product',
      slug: 'product',
      description: 'Roadmaps, launches, and product writing.',
    })

    const frameworkTag = await Tag.create({ name: 'framework', slug: 'framework' })
    const nextTag = await Tag.create({ name: 'next', slug: 'next' })
    const releaseTag = await Tag.create({ name: 'release', slug: 'release' })

    const launchPost = await Post.create({
      user_id: author.id,
      category_id: engineering.id,
      title: 'Shipping a Real Holo Blog on Next',
      slug: 'shipping-a-real-holo-blog-on-next',
      status: 'published',
      excerpt: 'A grounded walkthrough of building a real blog on top of the public Holo APIs.',
      body: 'This example app demonstrates a practical blog built with public Holo APIs, clear routes, and typed models.',
      published_at: timestamp,
    })

    await launchPost.tags().attach([frameworkTag.id, nextTag.id])

    const roadmapPost = await Post.create({
      user_id: author.id,
      category_id: product.id,
      title: 'Designing the Example App Roadmap',
      slug: 'designing-the-example-app-roadmap',
      status: 'published',
      excerpt: 'How the reference apps are staged so users can learn the framework by reading real code.',
      body: 'The roadmap locks shared product requirements first, then builds each vertical slice across all frameworks.',
      published_at: new Date('2026-04-24T14:30:00.000Z'),
    })

    await roadmapPost.tags().attach([frameworkTag.id, releaseTag.id])
  },
})
