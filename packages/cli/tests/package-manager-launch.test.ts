import { expect, it } from 'vitest'
import { resolvePackageManagerSpawn } from '../src/package-manager'

it('launches package-manager shims through the shell on Windows and directly elsewhere', () => {
  expect(resolvePackageManagerSpawn({ command: 'npm', args: ['exec', '--', 'nuxt', 'prepare'] }, 'win32')).toEqual({
    command: 'npm exec -- nuxt prepare',
    args: [],
    shell: true,
  })
  expect(resolvePackageManagerSpawn({ command: 'node', args: ['-e', 'require("node:fs").appendFileSync("a b.txt", "x")'] }, 'win32')).toEqual({
    command: 'node -e "require(\\"node:fs\\").appendFileSync(\\"a b.txt\\", \\"x\\")"',
    args: [],
    shell: true,
  })
  expect(resolvePackageManagerSpawn({ command: 'pnpm', args: ['install'] }, 'linux')).toEqual({
    command: 'pnpm',
    args: ['install'],
    shell: false,
  })
})
