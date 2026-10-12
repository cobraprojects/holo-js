import assert from 'node:assert/strict'
import { runMaintenance } from './example-app-maintenance.mjs'
import { setTimeout } from 'node:timers/promises'

export async function assertExampleAppCacheBehavior(cache, Category) {
  const key = 'app:category-count'
  const flexibleKey = 'app:flexible-category-count'
  const categories = []
  const count = () => Category.count()
  const initialCount = await count()
  const createCategory = async slug => {
    const category = await Category.create({ name: slug, slug, description: 'Cache lifecycle verification' })
    categories.push(category)
  }
  try {
    assert.equal(await cache.remember(key, 1, count), initialCount)
    await createCategory('cache-expiry')
    assert.equal(await count(), initialCount + 1)
    assert.equal(await cache.remember(key, 1, count), initialCount)
    await setTimeout(1100)
    assert.equal(await cache.remember(key, 1, count), initialCount + 1)

    assert.equal(await cache.flexible(flexibleKey, [1, 3], count), initialCount + 1)
    await createCategory('cache-refresh')
    assert.equal(await cache.flexible(flexibleKey, [1, 3], count), initialCount + 1)
    await setTimeout(1100)
    assert.equal(await cache.flexible(flexibleKey, [1, 3], count), initialCount + 1)
    const deadline = Date.now() + 2000
    while (await cache.flexible(flexibleKey, [1, 3], count) !== initialCount + 2 && Date.now() < deadline) {
      await setTimeout(20)
    }
    assert.equal(await cache.flexible(flexibleKey, [1, 3], count), initialCount + 2)
    await createCategory('cache-expiration')
    await setTimeout(3100)
    assert.equal(await cache.flexible(flexibleKey, [1, 3], count), initialCount + 3)
  } finally {
    for (const category of categories) await category.delete()
    await cache.forget(key)
    await cache.forget(flexibleKey)
    await cache.flush()
  }
  await cache.put('cli:forgotten', { title: 'Stored through the app' }, 60)
  runMaintenance('cache:forget', 'cli:forgotten')
  assert.throws(() => runMaintenance('cache:forget'), /Missing required argument.*key/)
  assert.equal(await cache.get('cli:forgotten'), null)
  runMaintenance('cache:forget', 'cli:forgotten')
  await cache.put('cli:cleared', { title: 'Database cache' }, 60)
  runMaintenance('cache:clear')
  assert.equal(await cache.get('cli:cleared'), null)
  const file = cache.driver('file')
  await file.put('cli:cleared', { title: 'File cache' }, 60)
  runMaintenance('cache:clear', '--driver', 'file')
  assert.equal(await file.get('cli:cleared'), null)
}
