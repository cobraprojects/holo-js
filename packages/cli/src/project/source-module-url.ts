import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Loader, Plugin } from 'esbuild'
import type { Node } from 'typescript'

const loaders: Readonly<Record<string, Loader>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
}

export function createSourceModuleUrlPlugin(): Plugin {
  return {
    name: 'holo-source-module-url',
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/, namespace: 'file' }, async ({ path }) => {
        const contents = await readFile(path, 'utf8')
        const loader = loaders[extname(path)] ?? 'js'
        if (!contents.includes('meta')) return { contents, loader }

        const ts = await import('typescript')
        const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest)
        const sourceUrl = JSON.stringify(pathToFileURL(path).href)
        const fragments: string[] = []
        let cursor = 0

        function visit(node: Node): void {
          if (ts.isPropertyAccessExpression(node)
            && node.name.text === 'url'
            && ts.isMetaProperty(node.expression)
            && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
            fragments.push(contents.slice(cursor, node.getStart(source)), sourceUrl)
            cursor = node.end
            return
          }
          ts.forEachChild(node, visit)
        }

        visit(source)
        fragments.push(contents.slice(cursor))
        return { contents: fragments.join(''), loader }
      })
    },
  }
}
