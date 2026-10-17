import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const docsDir = path.resolve(import.meta.dirname, '../docs')
const sourceDir = process.argv[2] ?? path.resolve(import.meta.dirname, '../../../packages')
const pages = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.md')) pages.push(full)
  }
}
walk(docsDir)

const sourceText = execFileSync('bash', ['-c', `find ${sourceDir}/*/src -name '*.ts' -o -name '*.svelte' -o -name '*.vue' | xargs cat`], { maxBuffer: 1 << 30 }).toString()
const knownWords = new Set(sourceText.match(/[A-Za-z_$][\w$]*/g))

const missing = []
let checked = 0
for (const page of pages) {
  for (const line of fs.readFileSync(page, 'utf8').split('\n')) {
    if (!line.startsWith('### ')) continue
    const code = line.match(/`([^`]+)`/)?.[1] ?? line.slice(4)
    const name = code.match(/([A-Za-z_$][\w$]*)\s*(?:\(|$|<|\s*\{)/)?.[1] ?? code.match(/[A-Za-z_$][\w$]*/)?.[0]
    if (!name || !/[a-z][A-Z]|\(|^[a-z]+$/.test(code)) continue
    checked++
    if (!knownWords.has(name)) missing.push(`${path.relative(docsDir, page)}: ${line}`)
  }
}
process.stdout.write(`${missing.join('\n')}\n`)
process.stdout.write(`checked ${checked} code headings, ${missing.length} not found in source\n`)
