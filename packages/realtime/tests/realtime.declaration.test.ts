import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, it } from 'vitest'

const execFileAsync = promisify(execFile)

type ExecFileError = Error & {
  readonly stdout?: string
  readonly stderr?: string
}

async function expectDeclarationEmitToPass(tsconfigPath: string): Promise<void> {
  try {
    await execFileAsync('bun', ['x', 'tsc', '-p', tsconfigPath], {
      cwd: join(import.meta.dirname, '..'),
    })
  } catch (error) {
    const failure = error as ExecFileError
    throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'))
  }
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

      await expectDeclarationEmitToPass(join(tempDir, 'tsconfig.json'))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
