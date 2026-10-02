import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', 'contracts/out/**', 'contracts/cache/**', 'contracts/lib/**',
              '**/artifacts/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '.devnode/**',
              '.calyptra/**', 'reference/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Architecture guide: structured logging only, no `any`.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Architecture guide: a module reaches another module only through its index.ts barrel.
    files: ['**/src/modules/**/*.ts', '**/src/modules/**/*.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{
      regex: '^\\.\\./(?!\\.\\.)[^/]+/(?!index\\.ts$).+',
      message: 'Import other modules through their index.ts barrel.',
    }] }] },
  },
  { files: ['scripts/**', '**/scripts/**'], rules: { 'no-console': 'off' } },   // scripts report progress on the terminal
);
