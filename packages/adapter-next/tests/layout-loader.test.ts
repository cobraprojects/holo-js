import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import layoutLoader from '../src/layout-loader'

type ClassLayout<TProps> = new (props: TProps) => { render(): unknown }

function renderComponent<TProps>(layout: ((props: TProps) => unknown) | ClassLayout<TProps>, props: TProps): unknown {
  return /^class\b/.test(Function.prototype.toString.call(layout))
    ? new (layout as ClassLayout<TProps>)(props).render()
    : (layout as (props: TProps) => unknown)(props)
}

vi.mock('@holo-js/adapter-next/internal/validation-layout', () => ({
  adapterNextLayoutInternals: {
    validationErrorsLayout: <TProps>(layout: (props: TProps) => unknown) => (props: TProps) => ({ provided: renderComponent(layout, props) }),
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

let compiledLayouts = 0

type CompiledLayout = { readonly default: (props: { readonly title: string }) => unknown, readonly theme?: string }

async function importLayout(root: string, file: string, source: string, pageExtensions?: readonly string[], bundler?: 'turbopack' | 'webpack'): Promise<CompiledLayout> {
  const compiled = join(root, file.replace(/\.tsx$/, `.compiled-${compiledLayouts += 1}.ts`))
  await writeFile(compiled, layoutLoader.call({ resourcePath: join(root, file), getOptions: () => ({ pageExtensions, bundler }) }, source)!)
  return await import(compiled) as CompiledLayout
}

async function renderLayout(root: string, file: string, source: string, pageExtensions?: readonly string[]): Promise<unknown> {
  return (await importLayout(root, file, source, pageExtensions)).default({ title: 'Posts' })
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

  it('provides validation errors around root layouts defined in another module', async () => {
    const project = await createProject(['app/layout.tsx'])
    await writeFile(join(project, 'app/shell.ts'), 'export default function Shell(props: { readonly title: string }) { return props.title }\nexport const withTitle = <TProps>(layout: TProps) => layout\n')

    expect(await renderLayout(project, 'app/layout.tsx', 'export { default } from \'./shell\'\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'import Shell from \'./shell\'\nexport default Shell\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'import Shell, { withTitle } from \'./shell\'\nexport default withTitle(Shell)\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'const Root = (props: { readonly title: string }) => props.title\nexport default (Root)\n')).toEqual({ provided: 'Posts' })
  })

  it('provides validation errors around a root layout marked use client, rendered from the server', async () => {
    for (const [layout, bundler] of [
      ['export default function RootLayout(props: { readonly title: string }) { return props.title }', 'turbopack'],
      ['export default class RootLayout { constructor(private readonly props: { readonly title: string }) {} render() { return this.props.title } }', 'turbopack'],
      ['export default function RootLayout(props: { readonly title: string }) { return props.title }', 'webpack'],
    ] as const) {
      const project = await createProject(['app/layout.tsx'])
      const source = `'use client'\n${layout}\nexport const theme = 'dark'\n`
      await writeFile(join(project, 'app/layout.tsx'), source)
      const compiled = await importLayout(project, 'app/layout.tsx', source, undefined, bundler)

      expect(compiled.theme).toBe('dark')
      expect(compiled.default({ title: 'Posts' })).toEqual({ provided: 'Posts' })
      expect(layoutLoader.call({ resourcePath: join(project, 'app/layout.tsx'), resourceQuery: '?holo-client-layout' }, source)).toBe(source)
    }
  })

  it('leaves nested layouts and files outside the app directory unchanged', async () => {
    const source = 'export default function Layout(props: { readonly title: string }) { return props.title }\n'
    const project = await createProject(['app/layout.tsx', 'app/admin/layout.tsx', 'components/layout.tsx'])

    expect(await renderLayout(project, 'app/admin/layout.tsx', source)).toBe('Posts')
    expect(await renderLayout(project, 'components/layout.tsx', source)).toBe('Posts')
  })

  it('finds root layouts by the page extensions the Next config sets', async () => {
    const source = 'export default function Layout(props: { readonly title: string }) { return props.title }\n'
    const project = await createProject(['app/layout.page.tsx', 'app/admin/layout.page.tsx', 'app/docs/layout.tsx'])

    expect(await renderLayout(project, 'app/layout.page.tsx', source, ['page.tsx'])).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/admin/layout.page.tsx', source, ['page.tsx'])).toBe('Posts')
    expect(await renderLayout(project, 'app/docs/layout.tsx', source, ['page.tsx'])).toBe('Posts')
  })

  it('registers the generated client layout entry as a webpack dependency so a missing entry rebuilds the layout', async () => {
    const project = await createProject(['app/layout.tsx'])
    const source = '\'use client\'\nexport default function RootLayout() { return null }\n'
    const dependencies: string[] = []

    layoutLoader.call({ resourcePath: join(project, 'app/layout.tsx'), addDependency: file => dependencies.push(file), getOptions: () => ({ bundler: 'webpack' }) }, source)

    expect(dependencies).toHaveLength(1)
    expect(await readFile(dependencies[0] ?? '', 'utf8')).toContain(JSON.stringify(join(project, 'app/layout.tsx')))
  })

  it('finds root layouts in the project the bundler builds, even when started from another directory', async () => {
    const project = await createProject(['app/layout.tsx'])
    vi.spyOn(process, 'cwd').mockReturnValue(join(project, '..'))
    const source = 'export default function RootLayout(props: { readonly title: string }) { return props.title }\n'
    const compiled = join(project, 'app/layout.compiled-root-context.ts')
    await writeFile(compiled, layoutLoader.call({ resourcePath: join(project, 'app/layout.tsx'), rootContext: project }, source)!)

    expect((await import(compiled) as CompiledLayout).default({ title: 'Posts' })).toEqual({ provided: 'Posts' })
  })

  it('keeps every line of a root layout in place and passes a source map pointing back to it', async () => {
    const project = await createProject(['app/layout.tsx'])
    const source = ['import type { ReactNode } from \'react\'', '', 'export default function RootLayout(props: { readonly children: ReactNode }) {', '  return props.children', '}', ''].join('\n')
    let output: { readonly code: string, readonly map?: unknown } | undefined

    layoutLoader.call({ resourcePath: join(project, 'app/layout.tsx'), callback: (_error, code, map) => { output = { code, map } } }, source)

    expect(output?.code.split('\n').slice(0, 5)).toEqual(source.split('\n').slice(0, 5))
    expect(output?.map).toMatchObject({ version: 3, sources: [join(project, 'app/layout.tsx')] })
  })

  it('watches only the possible parent layout files, so adding or removing one rebuilds the layout', async () => {
    const project = await createProject(['app/layout.tsx', 'app/admin/reports/layout.tsx'])
    const existing: string[] = []
    const missing: string[] = []

    layoutLoader.call({
      resourcePath: join(project, 'app/admin/reports/layout.tsx'),
      addDependency: file => existing.push(file),
      addMissingDependency: file => missing.push(file),
      getOptions: () => ({ pageExtensions: ['tsx', 'js'] }),
    }, 'export default function Layout() { return null }\n')

    expect(existing).toEqual([join(project, 'app/layout.tsx')])
    expect(missing).toEqual([join(project, 'app/admin/layout.tsx'), join(project, 'app/admin/layout.js'), join(project, 'app/layout.js')])
  })
})
