import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { verifyBrowserExports } from './validate-browser-exports.mjs'
import { stageLocalWorkspacePackages } from './local-workspace-packages.mjs'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'packages/adapter-next/package.json'))
const consumer = process.env.HOLO_BROWSER_BUNDLE_DIR ?? await mkdtemp(join(tmpdir(), 'holo-browser-bundle-'))
const registryVersion = process.env.HOLO_BROWSER_BUNDLE_VERSION

function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(entries.map(entry => entry.isDirectory()
    ? javascriptFiles(join(directory, entry.name))
    : entry.name.endsWith('.js') ? [join(directory, entry.name)] : []))
  return paths.flat()
}

async function verifyForm() {
  const { chromium } = await import('playwright')
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--port', '0'], {
    cwd: consumer,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', chunk => { output += chunk })
  server.stderr.on('data', chunk => { output += chunk })
  let browser
  try {
    let url
    for (let attempt = 0; attempt < 120; attempt++) {
      url = output.match(/http:\/\/localhost:\d+/)?.[0]
      if (url && output.includes('Ready')) break
      assert.equal(server.exitCode, null, output)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    assert.ok(url, output)
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(url)
    await page.getByRole('button', { name: 'Submit' }).click()
    await page.getByRole('alert').filter({ hasText: 'Name is required' }).waitFor()
    await page.getByRole('textbox', { name: 'Name' }).fill('Quote accepted')
    await page.getByRole('button', { name: 'Submit' }).click()
    await page.locator('output').filter({ hasText: 'Quote accepted' }).waitFor()
    await page.getByRole('textbox', { name: 'Name' }).fill('redirect')
    await page.getByRole('button', { name: 'Submit' }).click()
    await page.waitForURL('**/done')
    await page.getByRole('heading', { name: 'Redirect complete' }).waitFor()
    await page.goto(url)
    await page.getByRole('textbox', { name: 'Name' }).fill('forbidden')
    await page.getByRole('button', { name: 'Submit' }).click()
    await page.locator('#__holo_next_client_http_error__').filter({ hasText: '403' }).waitFor()
    assert.equal(await page.title(), '403: This page could not be accessed.')
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    await new Promise(resolvePromise => server.exitCode !== null ? resolvePromise() : server.once('exit', resolvePromise))
  }
}

console.log(`Browser bundle consumer: ${consumer}`)
if (!process.argv.includes('--reuse')) {
  if (!process.argv.includes('--skip-build') && !registryVersion) run('node', ['scripts/build-libraries.mjs'], root)
  const staging = registryVersion ? undefined : await stageLocalWorkspacePackages(root, consumer)
  const packages = staging ? JSON.parse(await readFile(join(staging, 'workspace-packages.json'), 'utf8')) : {}
  const dependencies = Object.fromEntries(['@holo-js/adapter-next', '@holo-js/forms', '@holo-js/security', '@holo-js/validation'].map(name => [name, registryVersion ?? `file:${packages[name]}`]))
  for (const name of ['next', 'react', 'react-dom', 'typescript', '@types/react', '@types/node']) {
    dependencies[name] = require(`${name}/package.json`).version
  }
  await cp(join(root, 'tests/fixtures/browser-bundle'), consumer, { recursive: true })
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2))
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'])
}
// Every root layout renders the validation errors provider, so it must stay free of
// @holo-js/validation, and useValidationErrors() must ship only to pages that call it.
const validationCode = 'ValidationContractError'
// The FNV-1a prime in validationFlashPage(), which only useValidationErrors() runs in the browser.
const validationErrorsHookCode = /16777619|0x1000193/

async function routeJavaScript(page) {
  const html = await readFile(join(consumer, '.next/server/app', page), 'utf8')
  const files = [...new Set([...html.matchAll(/src="\/_next\/(static\/[^"?]+\.js)/g)].map(match => match[1]))]
  const contents = await Promise.all(files.map(file => readFile(join(consumer, '.next', file))))
  return { gzipBytes: contents.reduce((total, content) => total + gzipSync(content).length, 0), source: contents.join('\n') }
}

async function verifyRouteJavaScript(bundler) {
  run('node', ['node_modules/next/dist/bin/next', 'build', `--${bundler}`])
  const [form, plain, errors] = await Promise.all(['index.html', 'done.html', 'errors.html'].map(routeJavaScript))
  assert.ok(form.source.includes(validationCode), `${bundler}: the useForm() page lost its validation code, so the guard below checks nothing`)
  assert.match(errors.source, validationErrorsHookCode, `${bundler}: the useValidationErrors() page lost the hook, so the guards below check nothing`)
  assert.ok(!plain.source.includes(validationCode), `${bundler}: a page without forms ships @holo-js/validation through the root layout`)
  assert.doesNotMatch(plain.source, validationErrorsHookCode, `${bundler}: a page without forms ships useValidationErrors()`)
  assert.doesNotMatch(form.source, validationErrorsHookCode, `${bundler}: a page that imports only useForm() ships useValidationErrors()`)
  return { form: form.gzipBytes, plain: plain.gzipBytes, validationErrors: errors.gzipBytes }
}

const routeGzipBytes = { turbopack: await verifyRouteJavaScript('turbopack'), webpack: await verifyRouteJavaScript('webpack') }
const files = await javascriptFiles(join(consumer, '.next/static'))
const chunks = await Promise.all(files.map(async (file) => {
  const content = await readFile(file)
  return { file: file.slice(consumer.length + 1), bytes: content.length, gzipBytes: gzipSync(content).length }
}))
const modules = await readFile(join(consumer, 'browser-modules.json'), 'utf8')
const compilerIncluded = /node_modules[\\/]typescript[\\/]/.test(modules)
const report = {
  nextVersion: require('next/package.json').version,
  compilerIncluded,
  bytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
  gzipBytes: chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0),
  routeGzipBytes,
  chunks,
}
await writeFile(join(consumer, 'bundle-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
assert.equal(compilerIncluded, false, 'Production browser compilation includes the TypeScript compiler')
assert.doesNotMatch(modules, /node_modules[\\/](?:tsup|esbuild|@nuxt[\\/]kit|nitropack)[\\/]/)
if (!registryVersion) await verifyBrowserExports(join(consumer, 'local-packages'), consumer)
await verifyForm()
console.log('Packaged production form validation, submission, redirect, and HTTP error handling passed')
