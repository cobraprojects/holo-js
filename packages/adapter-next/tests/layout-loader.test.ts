import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import layoutLoader from '../src/layout-loader'

vi.mock('@holo-js/adapter-next/internal/validation-layout', () => ({
  adapterNextLayoutInternals: {
    validationErrorsLayout: <TProps>(layout: (props: TProps) => unknown) => (props: TProps) => ({ provided: layout(props) }),
  },
}))

type ClassLayout<TProps> = new (props: TProps) => { render(): unknown }

function renderComponent<TProps>(layout: ((props: TProps) => unknown) | ClassLayout<TProps>, props: TProps): unknown {
  return /^class\b/.test(Function.prototype.toString.call(layout))
    ? new (layout as ClassLayout<TProps>)(props).render()
    : (layout as (props: TProps) => unknown)(props)
}

vi.mock('@holo-js/adapter-next/internal/validation-errors', () => ({
  adapterNextClientLayoutInternals: {
    validationErrorsClientLayout: <TProps>(layout: (props: TProps) => unknown) => (props: TProps) => ({ providedInBrowser: renderComponent(layout, props) }),
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

async function renderLayout(root: string, file: string, source: string, pageExtensions?: readonly string[]): Promise<unknown> {
  const path = join(root, file)
  const compiled = join(root, file.replace(/\.tsx$/, `.compiled-${compiledLayouts += 1}.ts`))
  await writeFile(compiled, layoutLoader.call({ resourcePath: path, getOptions: () => ({ pageExtensions }) }, source))
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

  it('provides validation errors around root layouts defined in another module', async () => {
    const project = await createProject(['app/layout.tsx'])
    await writeFile(join(project, 'app/shell.ts'), 'export default function Shell(props: { readonly title: string }) { return props.title }\nexport const withTitle = <TProps>(layout: TProps) => layout\n')

    expect(await renderLayout(project, 'app/layout.tsx', 'export { default } from \'./shell\'\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'import Shell from \'./shell\'\nexport default Shell\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'import Shell, { withTitle } from \'./shell\'\nexport default withTitle(Shell)\n')).toEqual({ provided: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', 'const Root = (props: { readonly title: string }) => props.title\nexport default (Root)\n')).toEqual({ provided: 'Posts' })
  })

  it('provides validation errors in the browser around a root layout marked use client', async () => {
    const project = await createProject(['app/layout.tsx'])

    expect(await renderLayout(project, 'app/layout.tsx', '\'use client\'\nexport default function RootLayout(props: { readonly title: string }) { return props.title }\n')).toEqual({ providedInBrowser: 'Posts' })
    expect(await renderLayout(project, 'app/layout.tsx', '\'use client\'\nexport default class RootLayout { constructor(private readonly props: { readonly title: string }) {} render() { return this.props.title } }\n')).toEqual({ providedInBrowser: 'Posts' })
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
})
