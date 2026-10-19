import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { field, safeParse, schema } from '../packages/validation/src/index.ts'

// Run with: node --import tsx scripts/measure-validation-form-memory.mjs [MiB=80] [runs=3]
// Each sample uses a fresh process; RSS is a measurement, never a test assertion.
const mib = 1024 ** 2
const [command = '80', size = '80', mode] = process.argv.slice(2)

if (command === '--worker') {
  const bytes = Number(size) * mib
  const boundary = 'holo-memory-boundary'
  let remaining = bytes
  let started = false
  const request = new Request('https://example.com/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    duplex: 'half',
    body: new ReadableStream({
      pull(controller) {
        if (!started) {
          started = true
          controller.enqueue(new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`))
        } else if (remaining > 0) {
          const chunk = new Uint8Array(Math.min(remaining, mib)).fill(97)
          remaining -= chunk.length
          controller.enqueue(chunk)
        } else {
          controller.enqueue(new TextEncoder().encode(`\r\n--${boundary}--\r\n`))
          controller.close()
        }
      },
    }),
  })
  globalThis.gc()
  const baselineRssMiB = process.memoryUsage().rss / mib
  const start = performance.now()
  let file
  if (mode === 'direct') {
    file = (await request.formData()).get('upload')
  } else if (mode === 'blob') {
    const body = await request.blob()
    file = (await new Response(body, { headers: request.headers }).formData()).get('upload')
  } else {
    assert.equal(mode, 'validation')
    const result = await safeParse(request, schema({ upload: field.file().required() }))
    assert.equal(result.valid, true)
    file = result.data.upload
  }
  assert.equal(file.size, bytes)
  process.stdout.write(JSON.stringify({ mode, uploadMiB: Number(size), baselineRssMiB, peakRssMiB: process.resourceUsage().maxRSS / 1024, elapsedMs: performance.now() - start }) + '\n')
} else {
  const runs = Number(process.argv[3] ?? 3)
  const uploadMiB = Number(command)
  assert.ok(Number.isInteger(uploadMiB) && uploadMiB > 0)
  assert.ok(Number.isInteger(runs) && runs > 0)
  const samples = []
  for (const variant of ['direct', 'blob', 'validation']) {
    for (let run = 0; run < runs; run += 1) {
      const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--worker', String(uploadMiB), variant], { encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      samples.push(JSON.parse(child.stdout))
    }
  }
  process.stdout.write(JSON.stringify({ node: process.version, samples }, null, 2) + '\n')
}
