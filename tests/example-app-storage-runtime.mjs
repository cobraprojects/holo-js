import assert from 'node:assert/strict'

export async function assertExampleAppStorageRuntime({ baseUrl }) {
  const response = await fetch(`${baseUrl}/api/framework/storage-check`)
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), {
    streamed: 'streamed contents',
    stat: { size: 17, mimeType: 'text/plain' },
    exists: true,
    pages: [['framework-storage-check/second.txt'], ['framework-storage-check/streamed.txt']],
  })
}
