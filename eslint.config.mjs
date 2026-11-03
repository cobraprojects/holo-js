// @ts-check
import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: [
      '.agents/**',
      '.claude/**',
      '.holo-js/**',
      '.kiro/**',
      '.vitest-builds/**',
      '.vscode/**',
      '**/dist/**',
      '**/.holo-cli/**',
      '**/.holo-js/**',
      '**/.holo-js/runtime/**',
      '**/.holo-js/generated/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.vitepress/**',
      '**/.next/**',
      '**/.svelte-kit/**',
      '**/.vitest-builds/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.vue',
      '**/*.svelte',
      'bun.lock',
      'coverage/**',
      '**/coverage/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['packages/db/src/**/*.ts', 'packages/db/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/db/src/**/types.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: [
      'packages/db/src/drivers/**/*.ts',
      'packages/db/src/manager.ts',
      'packages/db/src/model/metadata.ts',
      'packages/db/src/schema/resolvers/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      'no-console': 'off',
      'no-constant-condition': 'off',
      'prefer-const': 'off',
    },
  },
)
