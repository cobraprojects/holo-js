import type { ProjectScaffoldOptions } from '../shared'
import { getFrameworkDescriptor } from '../frameworks'

export function renderScaffoldEslintConfig(): string {
  return [
    'import js from \'@eslint/js\'',
    'import globals from \'globals\'',
    'import tseslint from \'typescript-eslint\'',
    '',
    'export default tseslint.config(',
    '  {',
    '    ignores: [',
    '      \'.holo-js/**\',',
    '      \'.next/**\',',
    '      \'.nuxt/**\',',
    '      \'.output/**\',',
    '      \'.svelte-kit/**\',',
    '      \'build/**\',',
    '      \'coverage/**\',',
    '      \'node_modules/**\',',
    '    ],',
    '  },',
    '  js.configs.recommended,',
    '  ...tseslint.configs.recommended,',
    '  {',
    '    files: [\'**/*.{js,mjs,cjs,ts,tsx,mts,cts}\'],',
    '    languageOptions: {',
    '      globals: globals.node,',
    '    },',
    '    rules: {',
    '      \'no-var\': \'error\',',
    '      \'prefer-const\': \'error\',',
    '      eqeqeq: [\'error\', \'always\', { null: \'ignore\' }],',
    '      \'@typescript-eslint/consistent-type-imports\': [\'error\', {',
    '        prefer: \'type-imports\',',
    '        fixStyle: \'inline-type-imports\',',
    '      }],',
    '    },',
    '  },',
    ')',
    '',
  ].join('\n')
}

export function renderScaffoldGitignore(): string {
  return [
    '# Dependencies',
    'node_modules',
    '',
    '# Environment',
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.prod',
    '.env.test',
    '.env.*.local',
    '',
    '# Holo',
    '.holo-js/framework',
    '.holo-js/generated',
    '.holo-js/runtime',
    '.holo-cli',
    '',
    '# Nuxt',
    '.nuxt',
    '.output',
    '.nitro',
    '.data',
    '.netlify',
    '.vercel',
    '',
    '# Next.js',
    '.next',
    'out',
    'next-env.d.ts',
    '',
    '# SvelteKit',
    '.svelte-kit',
    'build',
    '',
    '# Build / Misc',
    'dist',
    'coverage',
    '*.log',
    '*.tsbuildinfo',
    '',
    '# Database',
    '*.db',
    '*.sqlite',
    '*.sqlite3',
    '*.sqlite-wal',
    '*.sqlite-shm',
    '',
    '# Storage',
    'storage',
    '',
    '# OS',
    '.DS_Store',
    'Thumbs.db',
    '',
  ].join('\n')
}

export function renderScaffoldTsconfig(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  const framework = getFrameworkDescriptor(options.framework)

  if (framework.scaffold.tsconfig === 'nuxt') {
    return [
      '{',
      '  // https://nuxt.com/docs/guide/concepts/typescript',
      '  "files": [],',
      '  "references": [',
      '    {',
      '      "path": "./.nuxt/tsconfig.app.json"',
      '    },',
      '    {',
      '      "path": "./.nuxt/tsconfig.server.json"',
      '    },',
      '    {',
      '      "path": "./.nuxt/tsconfig.shared.json"',
      '    },',
      '    {',
      '      "path": "./.nuxt/tsconfig.node.json"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')
  }

  if (framework.scaffold.tsconfig === 'sveltekit') {
    return `${JSON.stringify({
      extends: '$app/tsconfig',
      compilerOptions: {
        strict: true,
      },
      include: ['src', 'vite.config.ts', 'server', 'config', '.holo-js/generated/**/*.ts'],
    }, null, 2)}\n`
  }

  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      incremental: true,
      plugins: [
        {
          name: 'next',
        },
      ],
      paths: {
        '@/*': ['./*'],
      },
    },
    include: [
      'next-env.d.ts',
      '**/*.ts',
      '**/*.tsx',
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
      '**/*.mts',
      '.holo-js/generated/**/*.ts',
    ],
    exclude: ['node_modules'],
  }, null, 2)}\n`
}

export function renderVSCodeSettings(options: Pick<ProjectScaffoldOptions, 'framework'>): string | undefined {
  const framework = getFrameworkDescriptor(options.framework)

  if (!framework.scaffold.vscodeVueHybridMode && framework.scaffold.tsconfig !== 'sveltekit') {
    return undefined
  }

  const settings: Record<string, unknown> = {
    'typescript.tsdk': 'node_modules/typescript/lib',
    'typescript.enablePromptUseWorkspaceTsdk': true,
  }

  if (framework.scaffold.vscodeVueHybridMode) {
    settings['vue.server.hybridMode'] = true
  }

  return `${JSON.stringify(settings, null, 2)}\n`
}
