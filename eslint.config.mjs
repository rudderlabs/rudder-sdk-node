import { defineConfig, globalIgnores } from 'eslint/config';
import babelParser from '@babel/eslint-parser';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import compat from 'eslint-plugin-compat';
import importX from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    '.husky/',
    'node_modules/',
    'reports/',
    '**/*.json',
    '**/*.md',
    '**/*.d.ts',
    '.nyc_output/',
    'examples/',
    'dist/',
    'coverage/',
  ]),
  js.configs.recommended,
  importX.flatConfigs.recommended,
  compat.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        sourceType: 'module',
      },
      sourceType: 'module',
    },
    plugins: {
      unicorn,
    },
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          cases: {
            camelCase: true,
            kebabCase: true,
            pascalCase: true,
          },
        },
      ],
      'unicorn/no-instanceof-array': 'error',
      'unicorn/no-static-only-class': 'error',
      'unicorn/consistent-destructuring': 'error',
      'unicorn/better-regex': 'error',
      'unicorn/no-for-loop': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/explicit-length-check': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/no-lonely-if': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-length-check': 'error',
      'unicorn/prefer-export-from': 'error',
      'compat/compat': 'warn',
    },
  },
]);
