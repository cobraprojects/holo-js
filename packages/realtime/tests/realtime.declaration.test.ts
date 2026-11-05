import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function emitFixtureDeclaration(tsconfigPath: string, fixturePath: string): { readonly errors: readonly string[], readonly declaration: string } {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (!config) {
    throw new Error(`Unable to read ${tsconfigPath}`)
  }

  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options })
  const fixture = program.getSourceFile(fixturePath)
  if (!fixture) {
    throw new Error(`${fixturePath} is not part of the program`)
  }

  let declaration = ''
  const emitted = program.emit(fixture, (_fileName, text) => { declaration = text }, undefined, true)
  const diagnostics = [
    ...config.errors,
    ...program.getSyntacticDiagnostics(fixture),
    ...program.getSemanticDiagnostics(fixture),
    ...program.getDeclarationDiagnostics(fixture),
    ...emitted.diagnostics,
  ]
  const errors = diagnostics.map(diagnostic => ts.formatDiagnostic(diagnostic, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getNewLine: () => '\n',
  }))
  return { errors, declaration }
}

describe('@holo-js/realtime declaration emit', () => {
  it('emits exported realtime query declarations for eager-loaded model results', async () => {
    const tempDir = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-declarations-'))

    try {
      await writeFile(join(tempDir, 'fixture.ts'), [
        'import { belongsToMany, column, defineGeneratedTable, defineModel } from \'../../db/src/index\'',
        'import { query } from \'../src/index\'',
        '',
        'const posts = defineGeneratedTable(\'posts\', {',
        '  id: column.id(),',
        '  title: column.string(),',
        '})',
        '',
        'const tags = defineGeneratedTable(\'tags\', {',
        '  id: column.id(),',
        '  name: column.string(),',
        '})',
        '',
        'const postTags = defineGeneratedTable(\'post_tags\', {',
        '  id: column.id(),',
        '  postId: column.integer(),',
        '  tagId: column.integer(),',
        '})',
        '',
        'const Tag = defineModel(tags)',
        'const Post = defineModel(posts, {',
        '  relations: {',
        '    tags: belongsToMany(() => Tag, postTags, \'postId\', \'tagId\'),',
        '  },',
        '})',
        '',
        'export const adminPost = query({',
        '  name: \'blog.admin.post\',',
        '  access: \'public\',',
        '  handler: async () => {',
        '    const post = await Post.query().with(\'tags\').first()',
        '    return {',
        '      post,',
        '      tags: await Tag.query().get(),',
        '    }',
        '  },',
        '})',
        '',
      ].join('\n'))
      await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: {
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './dist',
        },
        include: ['./fixture.ts'],
      }, null, 2))

      const result = emitFixtureDeclaration(join(tempDir, 'tsconfig.json'), join(tempDir, 'fixture.ts'))

      expect(result.errors).toEqual([])
      expect(result.declaration).toContain('export declare const adminPost:')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})
