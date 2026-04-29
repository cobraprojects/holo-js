import { defineConfig } from 'tsup'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

const builtinBareNames = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs',
  'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]

function buildBareToNodeRegex(): RegExp {
  const escaped = builtinBareNames.map(n => n.replace('/', '\\/'))
  return new RegExp(
    `(from\\s+")(${escaped.join('|')})(")`,
    'g',
  )
}

async function restoreNodeProtocol(dir: string): Promise<void> {
  const pattern = buildBareToNodeRegex()
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await restoreNodeProtocol(fullPath)
    } else if (entry.name.endsWith('.mjs')) {
      const content = await readFile(fullPath, 'utf8')
      const updated = content.replace(pattern, '$1node:$2$3')
      if (updated !== content) {
        await writeFile(fullPath, updated, 'utf8')
      }
    }
  }
}

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'runtime/index': 'src/portable/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
  async onSuccess() {
    await restoreNodeProtocol(outDir)
  },
})
