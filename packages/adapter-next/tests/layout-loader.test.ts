import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import layoutLoader from '../src/layout-loader'

vi.mock('@holo-js/adapter-next/internal/validation-layout', () => ({
  adapterNextLayoutInternals: {
    validationErrorsLayout: <TProps>(layout: (props: TProps) => unknown) => (props: TProps) => ({ provided: layout(props) }),
  },
}))

async function createProject(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(import.meta.dirname, '.layouts-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), 'export default function Layout() { return null }\n')
  }
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  onTestFinished(() => {
    vi.restoreAllMocks()
  })
  return root
}

async function renderLayout(root: string, file: string, source: string): Promise<unknown> {
  const path = join(root, file)
  const compiled = join(root, file.replace(/\.tsx$/, '.compiled.ts'))
  await writeFile(compiled, layoutLoader.call({ resourcePath: path }, source))
  const module = await import(compiled) as { readonly default: (props: { readonly title: string }) => unknown }
  return module.default({ title: 'Posts' })
}

describe('Next layout loader', () => {
  it('provides validation errors around every root layout, including route group roots and src/app', async () => {
    const source = 'export default function RootLayout(props: { readonly title: string }) { return props.title }\n'
    const project = await createProject(['app/layout.tsx', 'app/admin/layout.tsx'])
    expect(await renderLayout(project, 'app/layout.tsx', source)).toEqual({ provided: 'Posts' })

    const groups = await createProject(['app/(shop)/layout.tsx', 'app/(marketing)/about/layout.tsx'])
    expect(await renderLayout(groups, 'app/(shop)/layout.tsx', source)).toEqual({ provided: 'Posts' })
    expect(await renderLayout(groups, 'app/(marketing)/about/layout.tsx', source)).toEqual({ provided: 'Posts' })

    const sourceDirectory = await createProject(['src/app/layout.tsx'])
    expect(await renderLayout(sourceDirectory, 'src/app/layout.tsx', 'const Root = (props: { readonly title: string }) => props.title\nexport default Root\n')).toEqual({ provided: 'Posts' })
  })

  it('leaves nested layouts, client layouts and files outside the app directory unchanged', async () => {
    const source = 'export default function Layout(props: { readonly title: string }) { return props.title }\n'
    const project = await createProject(['app/layout.tsx', 'app/admin/layout.tsx', 'components/layout.tsx'])

    expect(await renderLayout(project, 'app/admin/layout.tsx', source)).toBe('Posts')
    expect(await renderLayout(project, 'components/layout.tsx', source)).toBe('Posts')
    expect(layoutLoader.call({ resourcePath: join(project, 'app/layout.tsx') }, `'use client'\n${source}`)).toBe(`'use client'\n${source}`)
  })
})
