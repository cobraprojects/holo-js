import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

async function withProductionServer(verify) {
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
    await verify(browser, url)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    await new Promise(resolvePromise => server.exitCode !== null ? resolvePromise() : server.once('exit', resolvePromise))
  }
}

async function verifyForm(browser, url) {
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
  await page.close()
}

async function showsNameError(page) {
  await page.getByRole('alert').filter({ hasText: 'Name is required' }).waitFor()
}

async function verifyValidationErrors(browser, url, bundler) {
  const errorsPage = new URL('/errors', url).href
  const withJavaScript = await browser.newPage()
  await withJavaScript.goto(errorsPage)
  await withJavaScript.getByRole('alert').filter({ hasText: 'No errors' }).waitFor()
  await withJavaScript.getByRole('button', { name: 'Save' }).click()
  await showsNameError(withJavaScript)
  // A call that mounts after the post agrees with the one that was already mounted.
  await withJavaScript.getByRole('status').filter({ hasText: 'Fix the name' }).waitFor()
  await withJavaScript.getByRole('textbox', { name: 'Name' }).fill('Ada')
  await withJavaScript.getByRole('button', { name: 'Save' }).click()
  await withJavaScript.getByRole('alert').filter({ hasText: 'No errors' }).waitFor()
  await withJavaScript.getByRole('status').filter({ hasText: 'Nothing to fix' }).waitFor()
  await withJavaScript.getByRole('textbox', { name: 'Name' }).fill('')
  await withJavaScript.getByRole('button', { name: 'Save' }).click()
  await showsNameError(withJavaScript)
  // Leaving the page drops its errors, so they don't reappear on the way back.
  await withJavaScript.getByRole('button', { name: 'Done' }).click()
  await withJavaScript.getByRole('heading', { name: 'Redirect complete' }).waitFor()
  await withJavaScript.goBack()
  await withJavaScript.getByRole('alert').filter({ hasText: 'No errors' }).waitFor()
  await withJavaScript.getByRole('button', { name: 'Save' }).click()
  await showsNameError(withJavaScript)
  await withJavaScript.reload()
  await withJavaScript.getByRole('alert').filter({ hasText: 'No errors' }).waitFor()
  await withJavaScript.close()

  const context = await browser.newContext({ javaScriptEnabled: false })
  const withoutJavaScript = await context.newPage()
  await withoutJavaScript.goto(errorsPage)
  await withoutJavaScript.getByRole('button', { name: 'Save' }).click()
  await showsNameError(withoutJavaScript)
  await context.close()

  // A form posted before the page hydrates renders its errors on the server; hydration must keep them.
  const hydrated = await browser.newPage()
  const hydrationErrors = []
  hydrated.on('console', message => { if (message.type() === 'error') hydrationErrors.push(message.text()) })
  hydrated.on('pageerror', error => hydrationErrors.push(error.message))
  await hydrated.goto(errorsPage)
  await hydrated.locator('form').evaluate(form => form.submit())
  await hydrated.waitForLoadState('load')
  await hydrated.waitForFunction(form => Object.keys(form).some(key => key.startsWith('__reactFiber')), await hydrated.locator('form').elementHandle())
  await showsNameError(hydrated)
  assert.deepEqual(hydrationErrors, [], `${bundler}: hydrating the errors of a form posted without JavaScript logged errors`)
  await hydrated.reload()
  await hydrated.getByRole('alert').filter({ hasText: 'No errors' }).waitFor()
  await hydrated.close()
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
// useValidationErrors() must cost nothing on pages that don't call it. Byte counts are compared
// raw: gzip of the same code moves by a few bytes with chunk boundaries and minified names.
const baselineAdapterVersion = process.env.HOLO_BROWSER_BUNDLE_BASELINE_ADAPTER ?? '0.5.0'
const routes = { form: 'index.html', plain: 'done.html' }

async function routeJavaScript(page) {
  const html = await readFile(join(consumer, '.next/server/app', page), 'utf8')
  const files = [...new Set([...html.matchAll(/src="\/_next\/(static\/[^"?]+\.js)/g)].map(match => match[1]))]
  const contents = await Promise.all(files.map(file => readFile(join(consumer, '.next', file))))
  // The source maps name every module a chunk holds, wherever the bundler split them.
  const maps = await Promise.all(files.map(async (file, index) => {
    const map = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(contents[index].toString('utf8'))?.[1]
    // Files without a map, such as the polyfills, hold no app or package modules.
    return map ? JSON.parse(await readFile(join(consumer, '.next', dirname(file), decodeURIComponent(map)), 'utf8')) : { sources: [] }
  }))
  // Next names the module that references a server action after the action's id, which changes between
  // builds, and webpack adds a hash to tell modules with the same name apart.
  const sources = [...new Set(maps.flatMap(map => [map, ...(map.sections ?? []).map(section => section.map)]).flatMap(map => map.sources ?? [])
    .map(source => source.replace(/\/data:[0-9a-f]+ /, '/data:<server action> ').replace(/\?[0-9a-f]{4}$/, '')))].sort()
  return {
    bytes: contents.reduce((total, content) => total + content.length, 0),
    gzipBytes: contents.reduce((total, content) => total + gzipSync(content).length, 0),
    sources,
  }
}

async function buildRoutes(bundler, pages = routes) {
  await rm(join(consumer, '.next'), { recursive: true, force: true })
  run('node', ['node_modules/next/dist/bin/next', 'build', `--${bundler}`])
  return Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await routeJavaScript(page)])))
}

async function withoutHookPage(build) {
  const hidden = `${consumer}-errors-page`
  await rename(join(consumer, 'app/errors'), hidden)
  try {
    return await build()
  } finally {
    await rename(hidden, join(consumer, 'app/errors'))
  }
}

async function withBaselineAdapter(build) {
  const installed = join(consumer, 'node_modules/@holo-js/adapter-next')
  const local = join(consumer, 'adapter-next-under-test')
  const packed = await mkdtemp(join(tmpdir(), 'holo-baseline-adapter-'))
  run('npm', ['pack', `@holo-js/adapter-next@${baselineAdapterVersion}`, '--pack-destination', packed, '--silent'])
  const [tarball] = (await readdir(packed)).filter(file => file.endsWith('.tgz'))
  run('tar', ['-xzf', join(packed, tarball), '-C', packed])
  await rename(installed, local)
  await rename(join(packed, 'package'), installed)
  try {
    return await build()
  } finally {
    await rm(installed, { recursive: true, force: true })
    await rename(local, installed)
    await rm(packed, { recursive: true, force: true })
  }
}

const hookModule = /@holo-js[\\/]adapter-next[\\/]dist[\\/]internal[\\/]use-validation-errors\.mjs$/
const errorBagModule = /@holo-js[\\/]validation[\\/]dist[\\/]internal[\\/]error-bag\.mjs$/

async function verifyRouteJavaScript(bundler) {
  const baseline = await withBaselineAdapter(() => withoutHookPage(() => buildRoutes(bundler)))
  const unused = await withoutHookPage(() => buildRoutes(bundler))
  for (const route of Object.keys(routes)) {
    assert.equal(unused[route].bytes, baseline[route].bytes, `${bundler}: ${routes[route]} ships ${unused[route].bytes - baseline[route].bytes} more bytes than with @holo-js/adapter-next@${baselineAdapterVersion}, in an app that never calls useValidationErrors()`)
  }
  const used = await buildRoutes(bundler, { ...routes, validationErrors: 'errors.html' })
  assert.ok(used.validationErrors.sources.some(source => hookModule.test(source)), `${bundler}: the useValidationErrors() page lost the hook, so the check below checks nothing`)
  assert.ok(used.validationErrors.sources.some(source => errorBagModule.test(source)), `${bundler}: the useValidationErrors() page lost the error bag, so the check below checks nothing`)
  for (const route of Object.keys(routes)) {
    assert.deepEqual(used[route].sources, unused[route].sources, `${bundler}: ${routes[route]} ships other modules once another page calls useValidationErrors()`)
  }
  await withProductionServer(async (browser, url) => {
    await verifyForm(browser, url)
    await verifyValidationErrors(browser, url, bundler)
  })
  return Object.fromEntries(Object.entries({ baseline, unused, used }).map(([build, pages]) => [build, Object.fromEntries(Object.entries(pages).map(([route, { bytes, gzipBytes }]) => [route, { bytes, gzipBytes }]))]))
}

const routeBytes = { turbopack: await verifyRouteJavaScript('turbopack'), webpack: await verifyRouteJavaScript('webpack') }
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
  routeBytes,
  chunks,
}
await writeFile(join(consumer, 'bundle-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
assert.equal(compilerIncluded, false, 'Production browser compilation includes the TypeScript compiler')
assert.doesNotMatch(modules, /node_modules[\\/](?:tsup|esbuild|@nuxt[\\/]kit|nitropack)[\\/]/)
if (!registryVersion) await verifyBrowserExports(join(consumer, 'local-packages'), consumer)
console.log('Packaged production forms and useValidationErrors(), with and without JavaScript, passed under Turbopack and webpack')
