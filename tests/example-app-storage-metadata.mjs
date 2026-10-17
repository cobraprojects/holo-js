import assert from 'node:assert/strict'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export async function assertExampleAppStorageMetadata(Storage) {
  for (const diskName of ['local', 'public']) {
    const disk = Storage.disk(diskName)
    try {
      await disk.put('metadata-check/avatar.txt', pngPixel)
      await disk.put('metadata-check/notes.png', 'plain notes')
      assert.deepEqual(await disk.stat('metadata-check/avatar.txt'), { size: pngPixel.length, mimeType: 'image/png' })
      assert.deepEqual(await disk.stat('/metadata-check/avatar.txt'), { size: pngPixel.length, mimeType: 'image/png' })
      assert.deepEqual(await disk.stat('metadata-check/notes.png'), { size: 11, mimeType: null })
      assert.equal(await disk.stat('metadata-check/missing.png'), null)
      await assert.rejects(disk.stat('../outside.png'))
    } finally {
      await disk.delete('metadata-check/avatar.txt')
      await disk.delete('metadata-check/notes.png')
    }
  }
}
