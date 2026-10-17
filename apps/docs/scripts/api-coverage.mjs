import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '../../../packages')
const docsRoot = path.resolve(import.meta.dirname, '../docs')

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })
}
const docsText = walk(docsRoot).map((f) => fs.readFileSync(f, 'utf8')).join('\n')

function tsupEntries(pkgDir) {
  const cfg = ['tsup.config.ts', 'tsup.config.mts'].map((f) => path.join(pkgDir, f)).find(fs.existsSync)
  if (!cfg) return {}
  const src = fs.readFileSync(cfg, 'utf8')
  const out = {}
  for (const m of src.matchAll(/['"]?([\w./-]+)['"]?\s*:\s*['"](src\/[^'"]+)['"]/g)) out[m[1]] = m[2]
  for (const m of src.matchAll(/['"](src\/[^'"]+)['"]/g)) {
    const key = path.basename(m[1]).replace(/\.tsx?$/, '')
    if (!Object.values(out).includes(m[1])) out[key] = m[1]
  }
  return out
}

const results = []
for (const name of fs.readdirSync(root).sort()) {
  const pkgDir = path.join(root, name)
  const pj = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pj)) continue
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
  if (!pkg.exports || typeof pkg.exports !== 'object') continue
  const entries = tsupEntries(pkgDir)
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (sub.includes('internal') || sub === './package.json') continue
    const typesPath = typeof target === 'string' ? target : target.types || target.import
    if (!typesPath) continue
    const key = typesPath.replace(/^\.\/dist\//, '').replace(/\.d\.(m)?ts$/, '').replace(/\.(m)?js$/, '')
    let srcFile = entries[key] ? path.join(pkgDir, entries[key]) : null
    if (!srcFile) {
      const guess = path.join(pkgDir, 'src', key + '.ts')
      if (fs.existsSync(guess)) srcFile = guess
      const guess2 = path.join(pkgDir, 'src', key, 'index.ts')
      if (!srcFile && fs.existsSync(guess2)) srcFile = guess2
    }
    if (!srcFile || !fs.existsSync(srcFile)) { results.push({ pkg: pkg.name, sub, error: 'no source for ' + key }); continue }
    const program = ts.createProgram([srcFile], { allowJs: false, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 })
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(srcFile)
    const sym = sf && checker.getSymbolAtLocation(sf)
    const exports = sym ? checker.getExportsOfModule(sym) : []
    const items = exports.map((s) => {
      let target = s
      if (s.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(s)
      const f = target.flags
      const kind = f & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable | ts.SymbolFlags.Enum) ? 'value' : 'type'
      return { name: s.getName(), kind, documented: new RegExp('\\b' + s.getName().replace(/\$/g, '\\$') + '\\b').test(docsText) }
    })
    results.push({ pkg: pkg.name, sub, src: path.relative(root, srcFile), items })
  }
}
fs.writeFileSync('/tmp/holo-api-coverage.json', JSON.stringify(results, null, 1))
let tv = 0, dv = 0, tt = 0, dt = 0
for (const r of results) {
  if (r.error) { process.stdout.write(`ERR ${r.pkg} ${r.sub} ${r.error}\n`); continue }
  const v = r.items.filter((i) => i.kind === 'value'), t = r.items.filter((i) => i.kind === 'type')
  tv += v.length; dv += v.filter((i) => i.documented).length; tt += t.length; dt += t.filter((i) => i.documented).length
  process.stdout.write(`${r.pkg}${r.sub === '.' ? '' : r.sub.slice(1)}\tvalues ${v.filter((i) => i.documented).length}/${v.length}\ttypes ${t.filter((i) => i.documented).length}/${t.length}\n`)
}
process.stdout.write(`TOTAL values ${dv}/${tv}  types ${dt}/${tt}\n`)
