import fs from 'node:fs'
import path from 'node:path'

const dist = path.resolve(import.meta.dirname, '../docs/.vitepress/dist')
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.html')) files.push(full)
  }
}
walk(dist)

const idsByPage = new Map()
const pageKey = (file) => '/' + path.relative(dist, file).replace(/\.html$/, '').replace(/(^|\/)index$/, '$1')
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8')
  idsByPage.set(pageKey(file), new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])))
}

const broken = []
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8')
  const page = pageKey(file)
  for (const [, href] of html.matchAll(/href="([^"]*#[^"]+)"/g)) {
    if (/^https?:/.test(href)) continue
    const [target, fragment] = href.split('#')
    const targetPage = target === '' ? page : target.replace(/\.html$/, '').replace(/(^|\/)index$/, '$1')
    const ids = idsByPage.get(targetPage)
    if (!ids) { broken.push(`${page} -> ${href} (no page)`); continue }
    if (!ids.has(decodeURIComponent(fragment))) broken.push(`${page} -> ${href}`)
  }
}
process.stdout.write(`${broken.length ? broken.join('\n') : 'all anchors resolve'}\n`)
process.stdout.write(`checked ${files.length} pages, ${broken.length} broken\n`)
