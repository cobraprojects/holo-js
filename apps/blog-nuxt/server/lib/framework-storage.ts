import { Storage } from '@holo-js/storage/runtime'

const directory = 'framework-storage-check'

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value)
}

export async function checkFrameworkStorage() {
  const disk = Storage.disk('local')
  try {
    await disk.writeStream(`${directory}/streamed.txt`, chunks('streamed ', 'contents'))
    await disk.put(`${directory}/second.txt`, 'second')
    const stream = await disk.readStream(`${directory}/streamed.txt`, { chunkBytes: 4096 })
    let streamed = ''
    for await (const chunk of stream ?? []) streamed += new TextDecoder().decode(chunk)
    const firstPage = await disk.listFiles(directory, { limit: 1 })
    const secondPage = await disk.listFiles(directory, { limit: 1, cursor: firstPage.nextCursor })

    return {
      streamed,
      stat: await disk.stat(`${directory}/streamed.txt`),
      exists: await disk.exists(`${directory}/second.txt`),
      pages: [firstPage.paths, secondPage.paths],
    }
  } finally {
    await disk.delete([`${directory}/streamed.txt`, `${directory}/second.txt`])
  }
}
