import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '../../..')
const nextBin = createRequire(join(repository, 'apps/blog-next/package.json')).resolve('next/dist/bin/next')
const run = promisify(execFile)

async function compiledFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  const contents = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return compiledFiles(path)
    return /\.(?:js|css)$/.test(entry.name) ? readFile(path, 'utf8') : ''
  }))
  return contents.join('\n')
}

it.each(['webpack', 'turbopack'])('uses prepared URLs without loading standalone CSS in native Next %s', async (compiler) => {
  const root = await mkdtemp(join(repository, '.holo-panels-compiler-'))
  try {
    await symlink(join(repository, 'apps/blog-next/node_modules'), join(root, 'node_modules'), 'dir')
    const files = {
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'next.config.mjs': `import { withHolo } from ${JSON.stringify(join(repository, 'packages/adapter-next/dist/config.mjs'))}
export default withHolo()`,
      '.holo-js/generated/panels/plugins.json': JSON.stringify({ version: 1, stylesheets: [{ name: 'editor', src: '/prepared-editor.123.css', components: ['rich-editor'] }] }),
      'app/layout.js': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }',
      'app/page.js': `import { load } from './styles.js'
import Client from './client.js'
export default async function Page() { return <><span>{await load()}</span><Client /></> }`,
      'app/client.js': `'use client'
import { useEffect, useState } from 'react'
import { load } from './styles.js'
export default function Client() {
  const [src, setSrc] = useState('')
  useEffect(() => { load().then(setSrc) }, [])
  return <span data-testid="client-src">{src}</span>
}`,
      'app/styles.js': `export async function load() {
  if (globalThis.__HOLO_PANELS_STYLESHEETS__) {
    return JSON.parse(globalThis.__HOLO_PANELS_STYLESHEETS__).editor
  } else {
    return (await import('./standalone.js')).editor
  }
}`,
      'app/standalone.js': "import './unused-editor.css'\nexport const editor = 'HOLO_STANDALONE_CATALOG_SENTINEL'",
      'app/unused-editor.css': '.holo-unused-editor-sentinel { color: red }',
    }
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    await run(process.execPath, [nextBin, 'build', `--${compiler}`], {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
      timeout: 120_000,
      maxBuffer: 8 * 1_048_576,
    })
    expect(await readFile(join(root, '.next/server/app/index.html'), 'utf8')).toContain('/prepared-editor.123.css')
    const client = await compiledFiles(join(root, '.next/static'))
    const server = await compiledFiles(join(root, '.next/server'))
    expect(client).toContain('/prepared-editor.123.css')
    for (const output of [client, server]) {
      expect(output.includes('HOLO_STANDALONE_CATALOG_SENTINEL')).toBe(false)
      expect(output.includes('holo-unused-editor-sentinel')).toBe(false)
    }
    const serverProcess = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const baseUrl = await new Promise<string>((resolveUrl, reject) => {
        let output = ''
        const inspect = (chunk: Buffer) => {
          output += chunk.toString()
          const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output)?.[1]
          if (url) resolveUrl(url)
        }
        serverProcess.stdout.on('data', inspect)
        serverProcess.stderr.on('data', inspect)
        serverProcess.once('error', reject)
        serverProcess.once('exit', () => reject(new Error(`Next exited before readiness: ${output}`)))
      })
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        const stylesheetRequests: string[] = []
        page.on('request', request => {
          if (request.resourceType() === 'stylesheet') stylesheetRequests.push(request.url())
        })
        await page.goto(baseUrl)
        await page.getByTestId('client-src').filter({ hasText: '/prepared-editor.123.css' }).waitFor()
        expect(stylesheetRequests).toEqual([])
      } finally {
        await browser.close()
      }
    } finally {
      if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
        const closed = new Promise<void>(resolveClosed => serverProcess.once('exit', () => resolveClosed()))
        serverProcess.kill('SIGTERM')
        await closed
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)
